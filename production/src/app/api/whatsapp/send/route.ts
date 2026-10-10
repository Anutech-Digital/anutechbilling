/**
 * POST /api/whatsapp/send  (authenticated, owner OR sales)
 *
 * Outbound WhatsApp message. Two shapes accepted:
 *   Text:     { to: "+91...", text: "Hello..." }
 *   Template: { to: "+91...", template: { name, language, components? } }
 *
 * Behaviour:
 *  - Persists a whatsapp_messages row (status='pending', then 'sent' or 'failed')
 *  - Returns the wamid + status from Meta
 *  - Optional `related` block links the message to a lead/quote/customer
 *    so the conversation thread on /whatsapp picks it up
 *
 * 24-hour rule (Meta policy):
 *   Outside the 24-hour conversation window with a contact, only
 *   pre-approved template messages can be sent. The send helper passes
 *   whichever shape the caller picked; Meta will reject text-after-24h
 *   with a clear error code (we surface the message).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp/client";
import { classifySendFailure } from "@/lib/whatsapp/send-failure";
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import { buildQuoteUpiQr } from "@/lib/pdf/upi-qr";
import { quoteAmountDue } from "@/lib/payments/amount-due";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { extensionTitle, isOneTimeQuote } from "@/lib/quotes/service-period";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const schema = z.object({
  to:   z.string().min(8).max(20),
  text: z.string().max(4096).optional(),
  template: z.object({
    name:       z.string().min(1).max(80),
    language:   z.string().min(2).max(20),     // e.g. en_US, hi
    components: z.array(z.unknown()).optional(),
  }).optional(),
  /** When set, the route renders this quote's PDF server-side and sends
   *  it as a document (text becomes the caption). */
  attach_quote_id: z.string().optional(),
  related: z.object({
    leadId:     z.string().optional(),
    quoteId:    z.string().optional(),
    customerId: z.string().uuid().optional(),
  }).optional(),
}).refine(
  // Exactly one of: text-only, template-only, or text+attachment.
  // Bare template with attachment isn't supported in this first cut.
  (v) => {
    const hasText     = Boolean(v.text);
    const hasTemplate = Boolean(v.template);
    const hasAttach   = Boolean(v.attach_quote_id);
    if (hasAttach && hasTemplate) return false;
    if (!hasText && !hasTemplate && !hasAttach) return false;
    if (hasText && hasTemplate)   return false;
    return true;
  },
  { message: "Provide exactly one of { text } or { template }; attach_quote_id can pair with text" },
);

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  // Authenticated only — RLS-scoped tenant
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id) {
    return NextResponse.json({ ok: false, error: "No tenant context" }, { status: 403 });
  }

  const { to, text, template, attach_quote_id, related } = parsed.data;

  try {
    // ── Attachment branch — render quote PDF server-side, send as
    //    "document" with the typed text becoming the caption.
    if (attach_quote_id) {
      const admin = createAdminClient();
      const { data: quote, error: qErr } = await admin
        .from("quotes")
        .select(`
          id, tenant_id, customer_id, customer_name, line_items, subtotal,
          discount_pct, tax_rate, amount, notes, expires_date, is_renewal, is_add_seats, is_one_off,
          is_extension, extension_months
        `)
        .eq("id", attach_quote_id)
        .single();
      if (qErr || !quote) {
        return NextResponse.json({ ok: false, error: "Quote not found" }, { status: 404 });
      }
      if (quote.tenant_id !== me.tenant_id) {
        return NextResponse.json({ ok: false, error: "Quote belongs to a different tenant" }, { status: 403 });
      }

      const { data: tenant } = await admin
        .from("tenants")
        .select("name, email, phone, gstin, address, state_code, upi_vpa, upi_payee_name, logo_url")
        .eq("id", me.tenant_id)
        .single();
      const { data: customer } = quote.customer_id
        ? await admin
            .from("customers")
            .select("contact_name, contact_email, contact_phone, gstin, state_code")
            .eq("id", quote.customer_id)
            .single()
        : { data: null };

      // Mirror the email-send route's math for PDF totals.
      const subtotal = quote.subtotal ?? quote.amount;
      const discount = Math.round(subtotal * ((quote.discount_pct ?? 0) / 100));
      const taxable  = subtotal - discount;
      const taxRate  = quote.tax_rate ?? 18;
      const tax      = quoteDisplayTax(taxable, taxRate, quote.amount); // R-804
      const total    = quote.amount ?? taxable + tax;
      const lineItems = (quote.line_items ?? []) as QuoteLineItem[];

      // Scan-to-pay on the PDF the customer receives over WhatsApp. This is the
      // shortest path there is from "quote arrives" to "money sent": the QR and
      // the UPI app are on the same phone. quoteAmountDue() gates it — non-INR
      // and already-invoiced quotes get no QR.
      const tUpi = tenant as { upi_vpa?: string | null; upi_payee_name?: string | null } | null;
      const upi = await buildQuoteUpiQr({
        vpa:       tUpi?.upi_vpa,
        payeeName: tUpi?.upi_payee_name ?? tenant?.name,
        quoteId:   quote.id,
        amountDue: quoteAmountDue(quote),
      });

      const blob = await renderQuotePDF({
        upiQrDataUrl:  upi?.dataUrl ?? null,
        upiVpa:        upi?.vpa ?? null,
        tenantName:    tenant?.name    ?? "Workspace",
        tenantLogo:    await logoDataUri((tenant as { logo_url?: string | null } | null)?.logo_url),
        tenantGstin:   tenant?.gstin   ?? null,
        tenantEmail:   tenant?.email   ?? null,
        tenantPhone:   tenant?.phone   ?? null,
        tenantAddress: tenant?.address ?? null,
        quoteId:       quote.id,
        customerName:  quote.customer_name,
        contactName:   customer?.contact_name  ?? null,
        contactEmail:  customer?.contact_email ?? null,
        contactPhone:  customer?.contact_phone ?? null,
        lineItems,
        subtotal,
        discountPct:   quote.discount_pct ?? 0,
        discount,
        taxable,
        taxRate,
        tax,
        total,
        interState:    isInterStateSupply(customer?.state_code, tenant?.state_code, { customerGstin: customer?.gstin, sellerGstin: tenant?.gstin }),
        validityDays:  30,
        notes:         quote.notes ?? undefined,
        isRenewal:     quote.is_renewal,
        oneTime:       isOneTimeQuote({
          isAddSeats: quote.is_add_seats, isOneOff: quote.is_one_off,
          isExtension: quote.is_extension, extensionMonths: quote.extension_months,
        }),
        extensionTitle: extensionTitle({ isExtension: quote.is_extension, extensionMonths: quote.extension_months }),
      });
      const buffer = Buffer.from(await blob.arrayBuffer());

      const result = await sendWhatsApp({
        tenantId: me.tenant_id,
        to,
        message: {
          kind:     "document",
          buffer,
          mime:     "application/pdf",
          filename: `Quote-${quote.id}.pdf`,
          caption:  text,           // user-typed text shows as document caption
        },
        // Auto-link the conversation thread back to the quote
        related: {
          ...related,
          quoteId:    related?.quoteId    ?? quote.id,
          customerId: related?.customerId ?? quote.customer_id ?? undefined,
        },
      });

      return NextResponse.json({
        ok:     true,
        wamid:  result.wamid,
        status: result.status,
        attached: { filename: `Quote-${quote.id}.pdf`, size: buffer.length },
      });
    }

    // ── Plain text or template branch (no attachment)
    const result = await sendWhatsApp({
      tenantId: me.tenant_id,
      to,
      message: text
        ? { kind: "text", text }
        : { kind: "template", name: template!.name, language: template!.language, components: template!.components },
      related,
    });
    return NextResponse.json({
      ok:     true,
      wamid:  result.wamid,
      status: result.status,
    });
  } catch (e) {
    /* Not one catch-all any more. A workspace that has not set up WhatsApp is the
     * caller's to fix (409, warn); Meta being unwell is ours (502, error). Lumping
     * them together put a settings page nobody filled in into the same error bucket
     * as a lost nightly backup — see lib/whatsapp/send-failure.ts. */
    const { status, level, message } = classifySendFailure(e);
    if (level === "warn") {
      console.warn("[/api/whatsapp/send] not configured:", message);
    } else {
      console.error("[/api/whatsapp/send] failed:", message);
    }
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
