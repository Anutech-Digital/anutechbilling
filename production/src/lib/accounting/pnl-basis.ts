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
 * views add up to the same cost. Expenses and the GST snapshot are the same in both.
 *
 * R-2624 (slice 4): Management also spreads REVENUE over the months it pays for — a ₹12,000 yearly
 * invoice dated 1 Oct is ₹1,000 a month Oct..Sep (SQL report_pnl_revenue_matched); GST view keeps
 * it on the invoice date. Output GST stays as invoiced in both views.
 */
import type { PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import type { RevenueByProductRow } from "@/lib/accounting/revenue-family";
import type { RevenueLineRow } from "@/lib/accounting/pnl-drill";
import { addDaysISO, istToday } from "@/lib/dates/ist";

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
    help: "Cost of goods in the month the licence was used, and prepaid revenue spread over the months it pays for (a yearly invoice = 1/12 a month). For running the business.",
  },
  {
    basis: "gst",
    label: "As invoiced (GST)",
    help: "Revenue on the invoice date and cost of goods on the vendor bill's date — the same as your GST returns and what your CA files.",
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

// ─── R-2624: revenue spread over the months it pays for ────────────────────────────────

/**
 * `report_pnl_revenue_matched(p_from, p_to)` — migration 20261109120954 (R-2624). The Management
 * view's revenue: each invoice / credit note / debit note share spread over its service months
 * (yearly prepaid = 1/12 a month, remainder in the last month), the part in the range. Same shape
 * as report_pnl's revenue columns + report_pnl_revenue_by_product, so the card, the product rows
 * and the drill (report_pnl_revenue_matched_lines) are the same rows added up.
 */
export interface MatchedRevenueRow {
  inv_taxable: number;
  cn_taxable: number;
  dn_taxable: number;
  revenue_count: number;
  by_product: RevenueByProductRow[];
}

type MatchedRevenueRpc = (
  fn: "report_pnl_revenue_matched", args: { p_from: string; p_to: string },
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/** R-2624: report_pnl_revenue_matched for a range; null on a database without the function. */
export async function fetchMatchedRevenue(
  supabase: { rpc: unknown },
  range: { from: string; to: string },
): Promise<MatchedRevenueRow | null> {
  const rpc = supabase.rpc as MatchedRevenueRpc;
  return matchedRevenueOrNull(await rpc.call(supabase, "report_pnl_revenue_matched", { p_from: range.from, p_to: range.to }));
}

/** Same rule as matchedRowOrNull: null ONLY for a missing function (PGRST202 / 42883); other errors throw. */
export function matchedRevenueOrNull(res: { data: unknown; error: { code?: string; message: string } | null }): MatchedRevenueRow | null {
  if (res.error) {
    if (res.error.code === "PGRST202" || res.error.code === "42883") return null;
    throw new Error(res.error.message);
  }
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!row || typeof row !== "object") return null;
  const r = row as Partial<Record<keyof MatchedRevenueRow, unknown>>;
  return {
    inv_taxable: Number(r.inv_taxable) || 0,
    cn_taxable: Number(r.cn_taxable) || 0,
    dn_taxable: Number(r.dn_taxable) || 0,
    revenue_count: Number(r.revenue_count) || 0,
    by_product: Array.isArray(r.by_product) ? (r.by_product as RevenueByProductRow[]) : [],
  };
}

/**
 * The report_pnl row with its revenue swapped for the spread one. Output GST (inv_tax / cn_tax /
 * dn_tax) stays as invoiced — GST is collected on the invoice, not earned over months — and the
 * project revenue split (project invoices are never spread: invoice month) is untouched.
 */
export function withMatchedRevenue(row: PnlRpcRow, rev: MatchedRevenueRow): PnlRpcRow {
  return {
    ...row,
    inv_taxable: rev.inv_taxable,
    cn_taxable: rev.cn_taxable,
    dn_taxable: rev.dn_taxable,
    revenue_count: rev.revenue_count,
    revenue_by_product: rev.by_product,
  };
}

/** How an invoice's service period was decided (SQL revenue_line_service_period) — shown in the drill. */
export function revenueBasisLabel(basis: string): string {
  switch (basis) {
    case "billing_part": return "billing part";
    case "line_dates": return "dates on the line";
    case "term": return "subscription term";
    case "invoice_month": return "invoice month";
    case "mixed": return "mixed periods";
    default: return basis;
  }
}

type RevenueLinesRpc = (
  fn: "report_pnl_revenue_lines" | "report_pnl_revenue_matched_lines",
  args: { p_from: string; p_to: string; p_families: string[] | null },
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/**
 * The Revenue drill's documents on the asked view — the same rows the card was added up from:
 * GST → report_pnl_revenue_lines (R-2181, invoice date); Management → report_pnl_revenue_matched_lines
 * (R-2624, the part of each document in the range by its service months). A database without the
 * matched function (PGRST202 / 42883) gives the GST rows — exactly what the card fell back to.
 */
export async function fetchRevenueDrillLines(
  supabase: { rpc: unknown },
  range: { from: string; to: string },
  families: string[] | null,
  basis: PnlBasis,
  /** R-2625: Management lists only months up to the current one (the card's own cut). */
  today: string = istToday(),
): Promise<RevenueLineRow[]> {
  const rpc = supabase.rpc as RevenueLinesRpc;
  const args = { p_from: range.from, p_to: range.to, p_families: families && families.length > 0 ? families : null };
  if (basis === "management") {
    const earned = earnedRange(range, today);
    if (!earned) return [];   // the whole range is after today: nothing earned yet (card ₹0)
    const { data, error } = await rpc.call(supabase, "report_pnl_revenue_matched_lines", { ...args, p_from: earned.from, p_to: earned.to });
    if (!error) return (Array.isArray(data) ? data : []) as RevenueLineRow[];
    if (error.code !== "PGRST202" && error.code !== "42883") throw new Error(error.message);
  }
  const { data, error } = await rpc.call(supabase, "report_pnl_revenue_lines", args);
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as RevenueLineRow[];
}

/**
 * R-2624: the line under Revenue. As invoiced it reads "₹X invoiced − ₹Y GST · N invoices"; on
 * Management the revenue is spread while GST stays as invoiced, so adding the two would print an
 * "invoiced" figure that no invoice has — it says what the number is instead.
 */
export function revenueHint(d: { revenue: number; outputGST: number; revenueCount: number; revenueSpread?: boolean }, money: (n: number) => string): string {
  const n = `${d.revenueCount} invoice${d.revenueCount === 1 ? "" : "s"}`;
  if (d.revenueSpread) return `${money(d.revenue)} earned this period before GST · ${n} · prepaid terms spread over their months`;
  return `${money(d.revenue + d.outputGST)} invoiced − ${money(d.outputGST)} GST · ${n}`;
}

/** R-2624: "N invoices issued" (as invoiced) / "N invoices with a part in this period" (spread). */
export function revenueCountText(d: { revenueCount: number; revenueSpread?: boolean }): string {
  const n = `${d.revenueCount} invoice${d.revenueCount === 1 ? "" : "s"}`;
  return d.revenueSpread ? `${n} with a part in this period` : `${n} issued`;
}

type MatchedRevenueMonthsRpc = (
  fn: "report_pnl_revenue_matched_months", args: { p_from: string; p_to: string },
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/** A month with no spread revenue: the SQL months call has no row for it. */
export const NO_MATCHED_REVENUE: MatchedRevenueRow = { inv_taxable: 0, cn_taxable: 0, dn_taxable: 0, revenue_count: 0, by_product: [] };

/**
 * R-2624 (checker: the FY trend made 12 heavy calls): every month's spread revenue in ONE call —
 * report_pnl_revenue_matched_months — "YYYY-MM" → that month's row (each equals
 * report_pnl_revenue_matched for the month; SQL test M1). Null when the database has no such
 * function (the trend then shows revenue as invoiced, as the statement does); other errors throw.
 */
export async function fetchMatchedRevenueMonths(
  supabase: { rpc: unknown },
  range: { from: string; to: string },
): Promise<Map<string, MatchedRevenueRow> | null> {
  const rpc = supabase.rpc as MatchedRevenueMonthsRpc;
  const res = await rpc.call(supabase, "report_pnl_revenue_matched_months", { p_from: range.from, p_to: range.to });
  if (res.error) {
    if (res.error.code === "PGRST202" || res.error.code === "42883") return null;
    throw new Error(res.error.message);
  }
  const out = new Map<string, MatchedRevenueRow>();
  for (const r of Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : []) {
    const row = matchedRevenueOrNull({ data: r, error: null });
    if (row && typeof r.month === "string") out.set(r.month.slice(0, 7), row);
  }
  return out;
}

// ─── R-2625: no revenue for months that have not happened ──────────────────────────────

/**
 * R-2625 (R-2624 checker: in November "This FY" on Management counted the Dec..Mar parts of yearly
 * invoices as earned). Management revenue counts only months that have happened or are happening:
 * the range is cut at the end of the current month (`today`'s month). Whole months, so "This
 * month" stays the whole month on BOTH sides (revenue and the matched cost of goods) and the FY
 * trend (months up to the current one) is untouched. Null = the whole range is after this month.
 */
export function earnedRange(range: { from: string; to: string }, today: string): { from: string; to: string } | null {
  const cut = monthEndOf(today);
  if (range.from > cut) return null;
  return { from: range.from, to: range.to < cut ? range.to : cut };
}

/** R-2625: the part of the range after this month (invoiced, not earned yet); null when none. */
export function notYetEarnedRange(range: { from: string; to: string }, today: string): { from: string; to: string } | null {
  const cut = monthEndOf(today);
  if (range.to <= cut) return null;
  const next = addDaysISO(cut, 1);
  return { from: range.from > next ? range.from : next, to: range.to };
}

/** Last day of the month of an ISO date (YYYY-MM-DD) — calendar arithmetic, no time zone. */
export function monthEndOf(iso: string): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** Revenue of a row the way the P&L adds it: invoices − credit notes + debit notes (before GST). */
export function netRevenueOf(r: Pick<MatchedRevenueRow, "inv_taxable" | "cn_taxable" | "dn_taxable">): number {
  return (Number(r.inv_taxable) || 0) - (Number(r.cn_taxable) || 0) + (Number(r.dn_taxable) || 0);
}

/**
 * R-2625: the note on a Management P&L whose range runs past this month — revenue is counted up to
 * the end of this month; what is already invoiced for the later months is not earned yet (part of
 * the Balance Sheet's Advance billing, which also holds what is unearned beyond this range). Null
 * when the range has nothing after this month.
 */
export function notYetEarnedNote(
  d: { revenueEarnedTo?: string; revenueNotYetEarned?: number },
  money: (n: number) => string, date: (iso: string) => string,
): string | null {
  if (!d.revenueEarnedTo) return null;
  const later = d.revenueNotYetEarned ?? 0;
  const head = `Management revenue is counted only up to the end of this month (${date(d.revenueEarnedTo)}) — later months have not happened yet.`;
  if (later === 0) return `${head} Nothing invoiced so far falls in those months.`;
  if (later < 0) return `${head} Credit notes of ${money(-later)} for those months will count when they come.`;
  return `${head} ${money(later)} already invoiced for them is not earned yet — it is part of the Advance billing on the Balance Sheet.`;
}
