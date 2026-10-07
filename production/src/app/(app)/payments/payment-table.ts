/**
 * Payments Received on the shared DataTable (R-215, 6 Oct 2026) — the logic, kept out of
 * React so it can be tested: the sortable headers and how the keyboard (j / k / Enter)
 * learns the order the table is actually painting.
 *
 * DataTable owns the sort and the "Load more" paging (R-104's 50-at-a-time rule), so the
 * page no longer knows which row is third on screen. The keyboard reads it back from the
 * painted rows instead of guessing — a guessed order would open a different quote than
 * the highlighted one after a header click.
 */
import type { SortValue } from "@/lib/table/data-table";
import { paymentMethodLabel } from "./method-label";

/** The fields of a payment the list sorts on. */
export interface PaymentSortRow {
  quote_id: string;
  received_at: string | null;
  amount: number;
  method: string;
  reference: string | null;
  status: string;
}

export type PaymentSortId = "date" | "customer" | "amount" | "method" | "reference" | "status";

/**
 * Header sort values. Customer comes from the payment's quote (the name the row shows),
 * so the page passes that lookup. Method sorts on the word on screen ("Bank transfer"),
 * not the stored key. No date / no reference sorts last (DataTable's empty-last rule).
 */
export function paymentSortValues<T extends PaymentSortRow>(
  customerNameOf: (p: T) => string | null | undefined,
): Record<PaymentSortId, (p: T) => SortValue> {
  return {
    date: (p) => p.received_at,
    customer: (p) => (customerNameOf(p) ?? "").trim() || null,
    amount: (p) => p.amount,
    method: (p) => paymentMethodLabel(p.method),
    reference: (p) => (p.reference ?? "").trim() || null,
    status: (p) => p.status,
  };
}

/** Attribute every painted payment row carries — `data-pay-row-id="<payment id>"`. */
export const PAY_ROW_ATTR = "data-pay-row-id";

/** Payment ids in the order the table paints them (after sort and paging). */
export function readRowIds(root: ParentNode | null): string[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll(`[${PAY_ROW_ATTR}]`)).map((el) => el.getAttribute(PAY_ROW_ATTR) ?? "");
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
