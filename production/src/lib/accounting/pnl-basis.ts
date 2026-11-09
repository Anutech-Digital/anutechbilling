/**
 * R-2622 (slice 2 of R-2156, 9 Nov 2026) — the P&L's two views of cost of goods.
 *
 * Found 30 Oct on the Oct 2026 P&L: Google's bill dated 7 Oct is for AUGUST licences (Google bills
 * in arrears), so October showed August's cost, October's own cost will land in December, and the
 * month read a 71% gross margin.
 *
 *   "As invoiced (GST)"     — cost of goods on the vendor bill's DATE (report_pnl). What the GST
 *                             returns and the CA's books use. Byte-identical to the P&L before.
 *   "Management (matched)"  — the same bills placed in the month the licence was USED (their
 *                             service month, SQL report_pnl_cogs_matched — R-2156): the pre-GST
 *                             subtotal spread over the service months. A vendor with no bill for
 *                             the month keeps the subscription-book estimate (R-1645), marked.
 *
 * Only the COGS bill subtotals move. GST that cannot be claimed on a COGS bill (R-1576) stays on
 * the bill date in both views (the drill lists it as its own row), so over a whole year the two
 * views add up to the same cost. Revenue, expenses and the GST snapshot are the same in both.
 */
import type { PnlRpcRow } from "@/lib/accounting/pnl-assemble";

type MatchedCogsRpc = (
  fn: "report_pnl_cogs_matched", args: { p_from: string; p_to: string },
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/** R-2622: report_pnl_cogs_matched for a range — the one call the P&L card and its drill share. */
export async function fetchMatchedCogs(
  supabase: { rpc: unknown },
  range: { from: string; to: string },
): Promise<MatchedCogsRow | null> {
  const rpc = supabase.rpc as MatchedCogsRpc;
  return matchedRowOrNull(await rpc.call(supabase, "report_pnl_cogs_matched", { p_from: range.from, p_to: range.to }));
}

export type PnlBasis = "management" | "gst";

export const PNL_BASIS_OPTIONS: ReadonlyArray<{ basis: PnlBasis; label: string; help: string }> = [
  {
    basis: "management",
    label: "Management (matched)",
    help: "Cost of goods in the month the licence was used (the vendor bill's service month). For running the business.",
  },
  {
    basis: "gst",
    label: "As invoiced (GST)",
    help: "Cost of goods on the vendor bill's date — the same as your GST returns and what your CA files.",
  },
];

/**
 * Which view the page opens on: the accountant (CA) works on the GST books, everyone else on the
 * management view. Role not known yet → GST (the view that never changes).
 */
export function defaultPnlBasis(role: string | null | undefined): PnlBasis {
  if (!role) return "gst";
  return role === "accountant" ? "gst" : "management";
}

/** A row of `report_pnl_cogs_matched().bills` — one per bill with a part in the range. */
export interface MatchedBill {
  id: string;
  vendor_name: string | null;
  bill_no: string | null;
  bill_date: string;
  category: string | null;
  /** The bill's whole pre-GST subtotal. */
  subtotal: number;
  service_from: string;
  service_to: string;
  /** How the service period was decided (SQL vendor_bill_service_period). */
  basis: "set" | "reference" | "vendor_default" | "bill_month" | string;
  /** The part of the subtotal that falls in the report range. */
  amount: number;
}

/** `report_pnl_cogs_matched(p_from, p_to)` — migration 20261109053500 (R-2156). */
export interface MatchedCogsRow {
  cogs: number;
  cogs_count: number;
  cogs_by_category: { category: string | null; subtotal: number; n: number }[];
  bills: MatchedBill[];
}

/**
 * The report_pnl row with its COGS bill figures swapped for the matched ones. Everything else —
 * revenue, expenses, the blocked GST on bills (bill_itc_groups, by bill date) — is untouched, so
 * assemblePnl and buildPnl (the R-1645 per-vendor estimate) run exactly as for the GST view.
 */
export function withMatchedCogs(row: PnlRpcRow, matched: MatchedCogsRow): PnlRpcRow {
  return {
    ...row,
    cogs: Number(matched.cogs) || 0,
    cogs_count: Number(matched.cogs_count) || 0,
    cogs_by_category: (matched.cogs_by_category ?? []).map((c) => ({
      category: c.category, subtotal: Number(c.subtotal) || 0, n: Number(c.n) || 0,
    })),
  };
}

/**
 * The matched RPC's single row; null ONLY when the database has no such function yet (an older
 * staging / live before the R-2156 deploy: PGRST202 / 42883) — the caller then shows the GST view
 * and says so. Any other failure (timeout, network) is thrown, so React Query shows the error and
 * retries instead of quietly caching GST numbers under the Management label.
 */
export function matchedRowOrNull(res: { data: unknown; error: { code?: string; message: string } | null }): MatchedCogsRow | null {
  if (res.error) {
    if (res.error.code === "PGRST202" || res.error.code === "42883") return null;
    throw new Error(res.error.message);
  }
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!row || typeof row !== "object") return null;
  const r = row as Partial<MatchedCogsRow>;
  return {
    cogs: Number(r.cogs) || 0,
    cogs_count: Number(r.cogs_count) || 0,
    cogs_by_category: Array.isArray(r.cogs_by_category) ? r.cogs_by_category : [],
    bills: Array.isArray(r.bills) ? r.bills : [],
  };
}

/** How a bill's service month was decided — shown next to the period so a misread is visible. */
export function serviceBasisLabel(basis: string): string {
  switch (basis) {
    case "set": return "set on the bill";
    case "reference": return "read from the bill text";
    case "vendor_default": return "Google / Microsoft bill: month before the bill date";
    case "bill_month": return "bill month";
    default: return basis;
  }
}
