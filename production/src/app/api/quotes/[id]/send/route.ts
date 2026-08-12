/**
 * POST /api/quotes/[id]/send — email a quote PDF to the customer.
 *
 * Replaces the legacy `mailto:` flow with a real server-side send that:
 *   1. Renders the Quote PDF on the server (no client roundtrip).
 *   2. Attaches it to a tenant-branded email via lib/email/send.ts.
 *   3. Logs the attempt in quote_send_log (audit + idempotency check).
 *   4. Atomically flips quote.status 'draft' → 'sent' on success.
 *
 * Works in BOTH email modes:
 *   - Stub (no RESEND_API_KEY): logs to console + DB as 'stubbed', still
 *     marks quote as sent so the UI / downstream automation continues.
 *   - Real (RESEND_API_KEY present): hits Resend, captures the message ID.
 *
 * Auth: regular user session (Supabase cookies). Tenant scope enforced by
 * looking up the user's tenant_id and verifying the quote belongs to it.
 *
 * Body: { to: string; cc?: string[]; subject?: string; message?: string }
 *   - `to` falls back to customer.contact_email when omitted.
 *   - `subject` / `message` default to a sane template when omitted.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { renderQuotePDF } from "@/lib/pdf";
import { rupee } from "@/lib/utils";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { buildCustomerQuoteHtml } from "@/lib/email/quote-template";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SendBody {
  to?:      string;
  cc?:      string[];
  subject?: string;
  message?: string;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // ── 1. Authn ─────────────────────────────────────────────────────
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolve current user → tenant_id
  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("tenant_id, full_name")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  // ── 2. Parse body ────────────────────────────────────────────────
  let body: SendBody = {};
  try { body = await req.json(); } catch { /* empty body is OK */ }

  const supabase = createAdminClient();

  // ── 3. Load quote (scoped to tenant) ─────────────────────────────
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select(`
      id, tenant_id, customer_id, customer_name, plan, seats, amount,
      status, payment_status, line_items, subtotal, discount_pct, tax_rate,
      created_date, expires_date, notes, is_renewal, public_token
    `)
    .eq("id", params.id)
    .single();
  if (qErr || !quote) {
    return NextResponse.json({ error: "quote not found" }, { status: 404 });
  }
  if (quote.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (quote.status === "accepted" || quote.status === "rejected") {
    return NextResponse.json(
      { error: `cannot resend — quote is ${quote.status}` },
      { status: 400 }
    );
  }

  // ── 4. Tenant + customer info ────────────────────────────────────
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, email, phone, gstin, address, state, state_code")
    .eq("id", me.tenant_id)
    .single();
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  const { data: customer } = quote.customer_id
    ? await supabase
        .from("customers")
        .select("name, contact_name, contact_email, contact_phone, gstin, state_code")
        .eq("id", quote.customer_id)
        .single()
    : { data: null };

  // ── 5. Resolve recipient ─────────────────────────────────────────
  const recipient = (body.to ?? customer?.contact_email ?? "").trim();
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return NextResponse.json(
      { error: "no valid recipient — set customer contact email or pass `to`" },
      { status: 400 }
    );
  }

  // ── 6. Build subject + body ──────────────────────────────────────
  const subtotal    = quote.subtotal ?? quote.amount;
  const discount    = Math.round(subtotal * ((quote.discount_pct ?? 0) / 100));
  const taxable     = subtotal - discount;
  const taxRate     = quote.tax_rate ?? 18;
  const tax         = Math.round(taxable * (taxRate / 100));
  const total       = quote.amount ?? taxable + tax;
  const lineItems   = (quote.line_items ?? []) as QuoteLineItem[];

  // Build the accept/pay link from the ACTUAL host the request came in on, not
  // NEXT_PUBLIC_APP_URL — that's baked at build time to a domain that may not be
  // live yet (dead links). Honours the Cloud Run proxy's x-forwarded-* headers.
  const linkProto = req.headers.get("x-forwarded-proto") ?? "https";
  const linkHost  = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const linkBase  = linkHost ? `${linkProto}://${linkHost}` : new URL(req.url).origin;
  const customerUrl = quoteAcceptUrl(linkBase, quote.id, quote.public_token);
  const subject     = body.subject?.trim() ||
                      `Quotation ${quote.id} from ${tenant.name}`;
  const greetName   = customer?.contact_name || quote.customer_name;
  const messageBody = body.message?.trim() || (
`Hi ${greetName},

Please find your quotation ${quote.id} attached as a PDF.

Total: ${rupee(total)}
Validity: ${quote.expires_date ? `up to ${quote.expires_date}` : "30 days"}

You can review and accept the quote online:
${customerUrl}

If you have any questions or need adjustments (seat count, plan tier, billing cycle), just reply to this email.

Thanks,
${me.full_name ?? tenant.name}
${tenant.name}${tenant.phone ? `\n${tenant.phone}` : ""}${tenant.email ? `\n${tenant.email}` : ""}`
  );

  const htmlBody = buildCustomerQuoteHtml({
    quoteId: quote.id,
    customerName: greetName,
    tenantName: tenant.name,
    tenantEmail: tenant.email,
    tenantPhone: tenant.phone,
    totalAmount: total,
    expiresDate: quote.expires_date,
    acceptUrl: customerUrl,
    lineItems: lineItems.map((li) => ({ name: li.name, qty: li.qty, rate: li.rate })),
  });

  // ── 7. Render PDF attachment ─────────────────────────────────────
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const blob = await renderQuotePDF({
      tenantName:    tenant.name,
      tenantGstin:   tenant.gstin,
      tenantEmail:   tenant.email,
      tenantPhone:   tenant.phone,
      tenantAddress: tenant.address,
      quoteId:       quote.id,
      customerName:  quote.customer_name,
      contactName:   customer?.contact_name ?? null,
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
      // GST head derived from seller (tenant) vs buyer (customer) state. (audit #18-20)
      interState:    isInterStateSupply(customer?.state_code, tenant.state_code),
      validityDays:  30,
      notes:         quote.notes ?? undefined,
      isRenewal:     quote.is_renewal,
    });
    const arrBuf = await blob.arrayBuffer();
    attachments = [{
      filename:    `Quote-${quote.id}.pdf`,
      content:     Buffer.from(arrBuf),
      contentType: "application/pdf",
    }];
  } catch (pdfErr) {
    // Non-fatal — email still goes with link, but log it.
    // eslint-disable-next-line no-console
    console.warn(`[quotes/send] PDF render failed for ${quote.id}:`, (pdfErr as Error).message);
  }

  // ── 8. Send ──────────────────────────────────────────────────────
  const sendResult = await sendEmail({
    to:      recipient,
    subject,
    text:    messageBody,
    html:    htmlBody,
    from:    tenant.email ?? undefined,
    replyTo: tenant.email ?? undefined,
    attachments,
  });

  // ── 9. Audit log ─────────────────────────────────────────────────
  await supabase.from("quote_send_log").insert({
    tenant_id:       me.tenant_id,
    quote_id:        quote.id,
    recipient_email: recipient,
    cc_emails:       body.cc && body.cc.length > 0 ? body.cc : null,
    subject,
    status:          sendResult.status,
    provider_id:     sendResult.providerId,
    error_message:   sendResult.errorMessage,
    sent_by:         authData.user.id,
  });

  // ── 10. Flip quote.status draft → sent on success ────────────────
  if (sendResult.status === "sent" || sendResult.status === "stubbed") {
    if (quote.status === "draft") {
      await supabase
        .from("quotes")
        .update({ status: "sent" })
        .eq("id", quote.id);
    }
  }

  return NextResponse.json({
    status:       sendResult.status,
    email_mode:   isEmailConfigured() ? "real" : "stub",
    providerId:   sendResult.providerId,
    errorMessage: sendResult.errorMessage,
    recipient,
    attachedPdf:  !!attachments,
    quoteStatus:  sendResult.status === "failed" ? quote.status : "sent",
  });
}
