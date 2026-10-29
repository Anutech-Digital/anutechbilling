/**
 * R-2033 (27 Oct 2026, Pardeep — localhost SCN Bharat Apps): on the customer Transactions tab
 * an R-1863/R-2023 advance holder quote read "Quote · ₹0 · Accepted", a cancelled one
 * "Quote · ₹0 · Rejected". It is the customer's ADVANCE (same rule as everywhere:
 * isCustomerAdvanceQuote): type "Advance", amount = the money received, status
 * "Available ₹X" (what is left of its customer credit) / "Used" / "Cancelled". It counts under
 * Payments, not Quotes. The row still opens /quotes/<holder> — the advance page.
 */
import { rupee } from "@/lib/utils";
import { advanceAvailable, isCustomerAdvanceQuote, type AdvanceQuoteFields } from "@/lib/quotes/customer-advance";

export interface AdvanceTxnQuote extends AdvanceQuoteFields {
  id: string;
  status?: string | null;
  payment_amount?: number | null;
}
export interface AdvanceTxnPayment { id: string; quote_id?: string | null; status?: string | null; amount?: number | null }
export interface AdvanceTxnCredit { amount: number; status: string; source_payment_id?: string | null; source_quote_id?: string | null }

export interface AdvanceTxnView { type: "Advance"; amount: number; status: string }

/** The Transactions row for an advance holder quote — null for any other quote. */
export function advanceTxnView(
  q: AdvanceTxnQuote,
  payments: readonly AdvanceTxnPayment[],
  credits: readonly AdvanceTxnCredit[],
): AdvanceTxnView | null {
  if (!isCustomerAdvanceQuote(q)) return null;
  const received = payments.filter((p) => p.quote_id === q.id && p.status === "received");
  const amount = received.reduce((s, p) => s + (p.amount ?? 0), 0) || (q.payment_amount ?? 0);
  if (q.status === "rejected") return { type: "Advance", amount, status: "Cancelled" };
  const payIds = new Set(received.map((p) => p.id));
  const mine = credits.filter((c) => (c.source_payment_id && payIds.has(c.source_payment_id)) || c.source_quote_id === q.id);
  const available = advanceAvailable(mine);
  return { type: "Advance", amount, status: available > 0 ? `Available ${rupee(Math.round(available))}` : "Used" };
}

/** Rows the Transactions "Payments" chip counts: payments, refunds and (R-2033) advances. */
export function isPaymentTxn(type: string): boolean {
  return type === "Payment" || type === "Refund" || type === "Advance";
}
