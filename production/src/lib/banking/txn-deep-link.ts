/**
 * R-1895: the bank account page opened with ?txn=<line id> (e.g. from the Salary Register) must
 * SHOW that line — whatever filters the page opened with, and even when it is an older month
 * past the first "Load more" page. Pure: the page applies the result and scrolls to the line.
 */
import { PAGE_SIZE, applyBankFilters, clearFilters, type BankFilters, type FilterContext, type FilterLine } from "./bank-filters";

/**
 * @returns the filters to use (unchanged when the line already passes them, otherwise every
 *          filter cleared — the sort stays) and how many lines to draw so it is included;
 *          null when the line is not in this account.
 */
export function revealTxn<T extends FilterLine>(
  lines: readonly T[],
  filters: BankFilters,
  ctx: FilterContext,
  txnId: string,
  pageSize: number = PAGE_SIZE,
): { filters: BankFilters; shownCount: number } | null {
  if (!lines.some((t) => t.id === txnId)) return null;
  let f = filters;
  let idx = applyBankFilters(lines, f, ctx).findIndex((t) => t.id === txnId);
  if (idx < 0) {
    f = clearFilters(filters);
    idx = applyBankFilters(lines, f, ctx).findIndex((t) => t.id === txnId);
  }
  if (idx < 0) return null;
  return { filters: f, shownCount: Math.max(pageSize, Math.ceil((idx + 1) / pageSize) * pageSize) };
}
