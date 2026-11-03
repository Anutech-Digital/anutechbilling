import { isRealBankReference } from "./bank-reference";

/**
 * R-2430 (p1 money) — the payment reference a receipt booked from a bank line carries.
 *
 * The line's own reference when it is a real UTR (isRealBankReference), trimmed; otherwise
 * `BANK-<bank line id>` — as the bank-credit RPCs already did for an EMPTY reference. Two
 * different credits whose statement prints a placeholder ("000000000000000") on the SAME quote /
 * invoice were "the same receipt again" to record_payment / record_multi_invoice_payment (they
 * replay on quote / invoice + reference) — the second was never booked. With the line id each
 * line is its own receipt, and the same line booked again still replays (booked once).
 *
 * TypeScript twin of public.bank_line_payment_reference(text, uuid)
 * (migration 20261103194201_r2430_placeholder_ref_bank_line).
 */
export function bankLinePaymentReference(reference: string | null | undefined, bankTxnId: string): string {
  /* Spaces only, as Postgres btrim() — a tab kept here is kept there too (one reference per line). */
  return isRealBankReference(reference) ? (reference ?? "").replace(/^ +| +$/g, "") : `BANK-${bankTxnId}`;
}
