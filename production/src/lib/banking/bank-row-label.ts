/**
 * The status word on a reconciled bank line (Banking → account page, row badge).
 *
 * R-2025 (0) — Pardeep 27 Oct (localhost, Acme ₹4,00,000 booked as "Advance — nothing to invoice
 * yet"): the row said "Payment", as if a sale had been paid. A line booked as a customer's
 * ADVANCE (R-1863 — same rule as bank_advance_payment() / isCustomerAdvanceQuote) reads "Advance".
 */
import type { BankTransactionRow } from "@/lib/queries/bank";
import { isCustomerAdvanceQuote, type AdvanceQuoteFields } from "@/lib/quotes/customer-advance";
import { rupee } from "@/lib/utils";

export function bankRowStatusLabel(t: BankTransactionRow["matched_to_type"], isAdvance: boolean, payments = 0): string {
  /* R-2098: one line that paid several items (payments.bank_txn_id) says how many. */
  return t === "payment"      ? (payments > 1 ? `${payments} payments` : isAdvance ? "Advance" : "Payment") :
         t === "expense"      ? "Expense" :
         t === "vendor_bill"  ? "Bill" :
         t === "transfer"     ? "Inter-account" :
         t === "split"        ? "Salaries" :
         t === "owner_equity" ? "Owner drawings / capital" :
         t                    ? "Reconciled" : "Unmatched";
}


/** The payment's note R-1863 writes (reconcile_bank_credit_as_advance). */
export const ADVANCE_PAYMENT_NOTE_PREFIX = "Advance on account — bank credit of ";

/** Which of these payments are bank ADVANCES — the note R-1863 writes AND its ₹0 holder quote. */
export function advancePaymentIds(
  payments: ReadonlyArray<{ id: string; quote_id: string | null; notes: string | null }>,
  quotes: ReadonlyArray<AdvanceQuoteFields & { id: string }>,
): Set<string> {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  return new Set(payments
    .filter((p) => (p.notes ?? "").startsWith(ADVANCE_PAYMENT_NOTE_PREFIX) && p.quote_id && isCustomerAdvanceQuote(byId.get(p.quote_id)))
    .map((p) => p.id));
}

/** R-2098: a receipt on a line that paid several items. */
export interface SplitLinePayment { id: string; amount: number; quote_id: string | null; invoice_id: string | null; receipt_voucher_no: string | null }

/** R-2098: the tooltip of an "N payments" line — one receipt per row. */
export function splitPaymentsTitle(pays: readonly SplitLinePayment[]): string {
  return pays.map((p) => `${rupee(p.amount)} · ${p.invoice_id ?? p.quote_id ?? "receipt"}${p.receipt_voucher_no ? ` (${p.receipt_voucher_no})` : ""}`).join("\n");
}
