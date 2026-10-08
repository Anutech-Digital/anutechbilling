/**
 * Expenses list on the shared DataTable (R-213, 6 Oct 2026) — the logic, kept out of
 * React so it can be tested: the page's filters, the sortable headers, and the filter
 * state a saved view stores.
 *
 * Filtering stays with the page (DataTable only sorts and paints): category is applied
 * in the query, payee / "To pay" / search here.
 */
import type { SortValue } from "@/lib/table/data-table";

/** The fields of an expense the list filters and sorts on. */
export interface ExpenseListRow {
  id: string;
  expense_date: string;
  category: string | null;
  vendor_name: string | null;
  description: string | null;
  payment_method: string | null;
  amount: number;
}

export interface ExpenseFilters {
  payee: string;
  unpaidOnly: boolean;
  search: string;
}

/**
 * Payee (exact vendor name), "To pay" (the page's own rowOwes — payroll and operating
 * expenses owe differently) and free-text search over category, vendor, note, method and
 * amount. Same rules the page used before it moved onto DataTable.
 */
export function filterExpenses<T extends ExpenseListRow>(
  rows: readonly T[],
  f: ExpenseFilters,
  rowOwes: (e: T) => boolean,
): T[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((e) =>
    (!f.payee || (e.vendor_name ?? "") === f.payee) &&
    (!f.unpaidOnly || rowOwes(e)) &&
    (!q || [e.category, e.vendor_name, e.description, e.payment_method, String(e.amount)]
      .some((v) => (v ?? "").toString().toLowerCase().includes(q))),
  );
}

/**
 * Sortable headers. Date sorts on the ISO date (string order = date order); amount on
 * the number, so ₹9,000 sorts below ₹10,000 and not after it as text would.
 */
export const EXPENSE_SORT: Record<"date" | "expense" | "vendor" | "amount", (e: ExpenseListRow) => SortValue> = {
  date: (e) => e.expense_date,
  expense: (e) => e.category,
  vendor: (e) => (e.vendor_name ?? "").trim() || null,
  amount: (e) => e.amount,
};

/** What a saved view remembers: the date range plus every filter on the page. */
export interface ExpenseViewState {
  from: string;
  to: string;
  category: string;
  payee: string;
  unpaidOnly: boolean;
  search: string;
}

export function expenseViewState(s: ExpenseViewState): Record<string, unknown> {
  return { from: s.from, to: s.to, category: s.category, payee: s.payee, unpaidOnly: s.unpaidOnly, search: s.search };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A saved view read back from this browser's storage. Anything missing or malformed
 * falls back to `current` (dates) or "no filter" — a bad entry must never blank the list.
 */
export function readExpenseView(v: Record<string, unknown>, current: ExpenseViewState): ExpenseViewState {
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const from = typeof v.from === "string" && ISO_DATE.test(v.from) ? v.from : current.from;
  const to = typeof v.to === "string" && ISO_DATE.test(v.to) ? v.to : current.to;
  return {
    from,
    to,
    category: str(v.category),
    payee: str(v.payee),
    unpaidOnly: v.unpaidOnly === true,
    search: str(v.search),
  };
}
