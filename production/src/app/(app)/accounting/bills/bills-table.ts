/**
 * Bills list on the shared DataTable (R-214, part of R-090): what each sortable column
 * sorts by, the search box, and a saved view's filter state. Pure — tested in
 * bills-table.test.ts; the page only renders.
 */
import type { SortValue } from "@/lib/table/data-table";
import { pickChoice } from "@/lib/hooks/use-url-choice";

export interface BillRowLike {
  vendor_name: string;
  vendor_gstin?: string | null;
  bill_no?: string | null;
  bill_date: string;
  total: number;
  paid_amount?: number | null;
  status: string;
  category?: string | null;
}

/** Whole rupees still owed on a bill (never below 0). */
export function billOutstanding(b: Pick<BillRowLike, "total" | "paid_amount" | "status">): number {
  if (b.status === "paid") return 0;
  return Math.max(0, Math.round((b.total ?? 0) - (b.paid_amount ?? 0)));
}

/** Column id → sort value. Empty bill numbers sort last (sortRows rule). */
export const BILL_SORT: Record<"vendor" | "bill_no" | "date" | "amount" | "status", (b: BillRowLike) => SortValue> = {
  vendor: (b) => b.vendor_name?.trim() || null,
  bill_no: (b) => b.bill_no?.trim() || null,
  date: (b) => b.bill_date || null,
  amount: (b) => b.total,
  status: (b) => b.status,
};

/** Search: vendor, bill #, GSTIN or category contains the text (case-insensitive). */
export function filterBills<T extends BillRowLike>(bills: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...bills];
  return bills.filter((b) =>
    [b.vendor_name, b.bill_no, b.vendor_gstin, b.category].some((v) => (v ?? "").toLowerCase().includes(q)),
  );
}

export type BillStatusFilter = "" | "unpaid" | "paid" | "partial" | "owed";
export const BILL_STATUS_FILTERS: readonly BillStatusFilter[] = ["", "owed", "unpaid", "partial", "paid"];

export interface BillsViewState {
  from: string;
  to: string;
  status: BillStatusFilter;
  q: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A saved view read back from this browser — anything malformed falls back to `current`. */
export function readBillsView(state: Record<string, unknown>, current: BillsViewState): BillsViewState {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const from = str(state.from);
  const to = str(state.to);
  return {
    from: from && ISO_DATE.test(from) ? from : current.from,
    to: to && ISO_DATE.test(to) ? to : current.to,
    status: pickChoice(str(state.status), BILL_STATUS_FILTERS, ""),
    q: str(state.q) ?? "",
  };
}
