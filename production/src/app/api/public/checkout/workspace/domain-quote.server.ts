/**
 * R-1985 (Pardeep, 26 Oct 2026): a MONTHLY (flex) Workspace order with "I need a new domain" is
 * paid in ONE payment, and the domain gets its OWN GST invoice ("usi payment me, alag invoice").
 *
 * Why a second quote (Option A — only paths that already exist): a flex order's first month is
 * invoiced as a subscription instalment (raise_subscription_billing, quote_id NULL — R-1974),
 * which cannot carry a one-time domain line. So the domain is its own quote, on the SAME lead:
 * one domain line with the registrant (R-1977's line, priced on the server by priceDomainLines),
 * invoiced by generate_invoice exactly like a cart domain. The one Razorpay payment is recorded
 * as two payments rows with the same reference — Workspace share on the Workspace quote, domain
 * share on this one — so each invoice is paid by its own share and nothing is counted twice
 * (supabase/tests/r1985_monthly_domain_split.test.sql). The webhook splits a live payment by the
 * order (split-payment.server.ts); a simulated order records both shares in the route.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { DOMAIN_QUOTE_PLAN, withGst } from "@/lib/checkout/split-order";

export { splitOrderNotes, withGst } from "@/lib/checkout/split-order";

type Admin = ReturnType<typeof createAdminClient>;

export interface DomainQuoteInput {
  tenantId: string;
  leadId: string;
  companyName: string;
  domain: string;
  /** The priced domain line (priceDomainLines + registrant). Its rate is never discounted. */
  line: { rate: number } & Record<string, unknown>;
  notes: string;
  createdDate: string;
  expiresDate: string;
  attribution: Record<string, unknown>;
}

export type DomainQuote = { quoteId: string; publicToken: string; subtotal: number; amount: number };

/** Insert the domain quote (status sent, awaiting payment). Null when it could not be saved. */
export async function insertDomainQuote(admin: Admin, a: DomainQuoteInput): Promise<DomainQuote | null> {
  const { data: qid, error: numErr } = await admin
    .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: a.tenantId });
  if (numErr || !qid) {
    console.error("[checkout/workspace] domain quote number failed:", numErr);
    return null;
  }
  const quoteId = qid as string;
  const subtotal = a.line.rate;
  const amount = withGst(subtotal);
  const { data, error } = await admin.from("quotes").insert({
    id:             quoteId,
    tenant_id:      a.tenantId,
    customer_id:    null,
    customer_name:  a.companyName,
    lead_id:        a.leadId,           // the same lead: record_payment reuses its customer
    plan:           DOMAIN_QUOTE_PLAN,
    seats:          1,
    line_items:     [a.line],
    subtotal,
    total_cost:     0,
    discount_pct:   0,
    tax_rate:       18,
    amount,
    status:         "sent",
    payment_status: "awaiting",
    owner_id:       null,
    domain:         a.domain,
    created_date:   a.createdDate,
    expires_date:   a.expiresDate,
    notes:          a.notes,
    ...a.attribution,
  }).select("public_token").single();
  if (error || !data?.public_token) {
    console.error("[checkout/workspace] domain quote insert failed:", error ?? "no public_token returned");
    return null;
  }
  return { quoteId, publicToken: data.public_token as string, subtotal, amount };
}
