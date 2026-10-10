/**
 * A quotation's PDF, ready to attach — built in ONE place, for every letter that mentions it.
 *
 * ─── THE LETTER THAT NAMED A DOCUMENT AND DID NOT CARRY IT ──────────────────
 * 31 Aug 2026, 16:20. Pardeep confirmed monthly billing and the agent wrote back:
 *
 *     "We have prepared quotation Q-ADPL-2026-27-0068 for 25 seats of Google Workspace
 *      Business Starter at Rs 325 per seat per MONTH plus 18% GST, totaling Rs 8,125 plus
 *      18% GST per month.
 *      Confirm quotation Q-ADPL-2026-27-0068 and I will initiate your account setup."
 *
 * Nothing attached. The PDF had gone out seven minutes earlier in a separate mail, so the
 * document existed — but a reader of THAT letter looks for an attachment and finds none, and
 * has to go hunting through their inbox for a message they may not have opened.
 *
 * The rule this settles: **a letter that names a document carries it.** Not "a document was
 * emailed at some point", which is a fact about our outbox, not about the customer's screen.
 *
 * ─── AND WHY IT IS ITS OWN FILE ─────────────────────────────────────────────
 * This was forty lines inside `sendAutoQuote`, reachable only by that one path. Now the AI's
 * reply needs the same bytes, and copying them would leave two places rendering the same
 * money document — which is precisely the shape that has cost this project all day: the
 * twelvefold divisor, the flex year, the rupee glyph, the duplicated quotation. One artifact,
 * one builder.
 *
 * Returns null on ANY failure. A missing attachment costs a click; a thrown error inside a
 * reply path costs the reply, and the customer is left with silence.
 */
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import type { createAdminClient } from "@/lib/supabase/server";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";

type Admin = ReturnType<typeof createAdminClient>;

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export async function quotePdfAttachment(
  admin: Admin,
  tenantId: string,
  quoteId: string,
): Promise<MailAttachment | null> {
  try {
    const { data: q } = await admin
      .from("quotes")
      .select("id, customer_name, line_items, subtotal, discount_pct, tax_rate, amount, notes, is_renewal, billing_cycle")
      .eq("id", quoteId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const quote = q as {
      id: string; customer_name: string | null; line_items: unknown;
      subtotal: number | null; discount_pct: number | null; tax_rate: number | null;
      amount: number | null; notes: string | null; is_renewal: boolean | null;
      billing_cycle: string | null;
    } | null;
    if (!quote) return null;

    const { data: t } = await admin
      .from("tenants")
      .select("name, email, phone, gstin, address, logo_url")
      .eq("id", tenantId)
      .maybeSingle();
    const tenant = (t ?? {}) as {
      name: string | null; email: string | null; phone: string | null;
      gstin: string | null; address: string | null; logo_url: string | null;
    };

    /* Every figure from the ROW. Recomputing here would let this attachment disagree with
       the one `sendAutoQuote` already sent for the same quote — same document, two prices. */
    const lineItems   = (Array.isArray(quote.line_items) ? quote.line_items : []) as QuoteLineItem[];
    const subtotal    = quote.subtotal ?? 0;
    const discountPct = quote.discount_pct ?? 0;
    const discount    = Math.round(subtotal * (discountPct / 100));
    const taxable     = subtotal - discount;
    const taxRate     = quote.tax_rate ?? 18;
    const tax         = quoteDisplayTax(taxable, taxRate, quote.amount); // R-804
    const total       = quote.amount ?? taxable + tax;

    const blob = await renderQuotePDF({
      upiQrDataUrl:  null,
      upiVpa:        null,
      tenantName:    tenant.name ?? "",
      tenantGstin:   tenant.gstin,
      tenantEmail:   tenant.email,
      tenantPhone:   tenant.phone,
      tenantAddress: tenant.address,
      tenantLogo:    await logoDataUri(tenant.logo_url),
      quoteId:       quote.id,
      customerName:  quote.customer_name ?? "",
      contactName:   null,
      contactEmail:  null,
      contactPhone:  null,
      lineItems,
      subtotal,
      discountPct,
      discount,
      taxable,
      taxRate,
      tax,
      total,
      interState:    false,
      validityDays:  30,
      billingCycle:  (quote.billing_cycle ?? undefined) as never,
      notes:         quote.notes ?? undefined,
      isRenewal:     quote.is_renewal ?? false,
    });

    return {
      filename:    `Quote-${quote.id}.pdf`,
      content:     Buffer.from(await blob.arrayBuffer()),
      contentType: "application/pdf",
    };
  } catch (err) {
    console.error("[quote-pdf-attachment] could not build the PDF:", err);
    return null;
  }
}

/**
 * Does this letter actually name the quotation?
 *
 * The trigger is the TEXT, not the existence of a document. A "thanks, noted" reply should not
 * drag a PDF along; a letter that says "quotation Q-… is prepared at Rs …" must.
 */
export function mentionsQuote(body: string, quoteId: string | null | undefined): boolean {
  if (!quoteId) return false;
  return body.includes(quoteId);
}
