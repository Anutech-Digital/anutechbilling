/**
 * The dashboard's "Recent activity" line for a quote.
 *
 * R-2029 (27 Oct 2026): an R-1863 / R-2023 customer advance — a ₹0 "Advance on account" holder
 * quote with the money received — read "Quote paid: Q-… · ₹0". It is not a sale: by the one
 * rule (isCustomerAdvanceQuote) it reads "Customer advance · ₹X · <customer>", X = the money
 * received (payment_amount).
 */
import { rupee } from "@/lib/utils";
import { CUSTOMER_ADVANCE_LABEL, isCustomerAdvanceQuote, type AdvanceQuoteFields } from "@/lib/quotes/customer-advance";

export interface ActivityQuote extends AdvanceQuoteFields {
  id: string;
  status: string;
  payment_status: string | null;
  payment_amount?: number | null;
  customer_name: string | null;
}

export function quoteActivityTitle(q: ActivityQuote): string {
  if (q.payment_status === "received" && isCustomerAdvanceQuote(q)) {
    return `${CUSTOMER_ADVANCE_LABEL} · ${rupee(q.payment_amount ?? 0, { compact: true })} · ${q.customer_name ?? ""}`.replace(/ · $/, "");
  }
  return q.payment_status === "received"
    ? `Quote paid: ${q.id} · ${rupee(q.amount ?? 0, { compact: true })}`
    : `Quote ${q.status === "sent" ? "sent" : "created"}: ${q.id} · ${q.customer_name}`;
}
