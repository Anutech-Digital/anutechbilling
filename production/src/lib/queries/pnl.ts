/**
 * The P&L for a period — one aggregation, shared.
 *
 * Lived inside the P&L page until 27 Sep 2026. The Balance Sheet needs the same number
 * for the whole life of the books (cumulative net profit = retained earnings), and a
 * second copy of a 200-line aggregation is how two reports come to disagree about profit.
 *
 * ─── S17 (28 Sep 2026): TRANSACTIONS KA JOD AB SQL ME ───────────────────────
 * Pehle ye hook period ki har invoice, har expense, har note browser me laata tha — aur
 * Balance Sheet isse BOOKS_START se aaj tak maangti hai, yaani poori kitaab. `report_pnl`
 * (migration 20260928110000) wahi filters SQL me chalata hai aur jode hue groups deta hai;
 * niyam (ITC, expense report, project cost, COGS basis) lib/accounting/pnl-assemble.ts
 * me wahi purane functions hain. Subscriptions / project labour / employees master data
 * hain (transactions ke saath nahi badhte), isliye yahin padhe jaate hain.
 *
 * ─── R-1647 (24 Oct 2026): THE TREND IS THE SAME P&L, MONTH BY MONTH ────────
 * usePnLMonths() reads the masters ONCE and runs report_pnl per month through the same
 * assemblePnl(), so a month on the FY trend is exactly that month's P&L.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/keys";
import { createClient } from "@/lib/supabase/client";
import { vendorsFromSubscriptions } from "@/lib/accounting/pnl";
import { assemblePnl, type PnLNumbers, type PnlMasters, type PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import type { RevenueByProductRow } from "@/lib/accounting/revenue-family";
import { fyMonthsSoFar, monthRange } from "@/lib/accounting/pnl-charts";
import { rpcRowOrThrow } from "@/lib/accounting/report-rpc";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { AssetBlock } from "@/lib/accounting/depreciation";
import { fetchDirectorPayroll } from "@/lib/queries/director-payroll";

export type { PnLNumbers } from "@/lib/accounting/pnl-assemble";

/** Wide enough to hold every entry the books have; the Balance Sheet reads profit from here. */
export const BOOKS_START = "2000-04-01";

type Range = { from: string; to: string };
type Client = ReturnType<typeof createClient>;

/** The master data a P&L needs, read once — the subscription book is prorated per range. */
async function fetchPnlMasters(supabase: Client) {
  /* R-265: the master-data reads page with fetchAllRows on `id` — a bare select stops
     at PostgREST's 1000-row cap and the subscription cost / project cost would silently
     cover only the first 1000 rows. fetchAllRows throws a page's error itself. */
  const [subs, labourRows, emps, projects, assets, directorPayroll] = await Promise.all([
    /* ── THE SUBSCRIPTION BOOK — where the licence cost actually lives ──────
       `vendor_bills` is EMPTY on this tenant, so billed COGS is ₹0 and the report used
       to claim a 100% gross margin. The subscriptions carry the cost; lib/accounting/
       pnl.ts prorates it by how long each ran inside the window and labels the basis,
       so an estimate never renders as a fact. */
    fetchAllRows((a, b) => supabase.from("subscriptions")
      .select("id, vendor, seats, mrr, start_date, renewal_date, item_id, status")
      .neq("status", "cancelled")
      .order("id").range(a, b)),
    /* ── PROJECT DELIVERY COST — salary spent building customers' software ──
       project_labour says who worked on which project; that salary moves from operating
       expenses into cost of goods — moved, never added (lib/accounting/project-cost.ts).
       R-1649: `employees` is readable by owner / manager / accountant only (R-1001); for any
       other role the salary is missing and project-cost.ts reports it as hidden, never ₹0. */
    fetchAllRows((a, b) => supabase.from("project_labour")
      .select("id, project_id, employee_id, percent, months, start_date, end_date")
      .order("id").range(a, b)),
    fetchAllRows((a, b) => supabase.from("employees").select("id, name, monthly_gross").order("id").range(a, b)),
    fetchAllRows((a, b) => supabase.from("project_sales").select("id, title, customer_name, start_date").order("id").range(a, b)),
    /* ── R-1578: THE FIXED-ASSET REGISTER — its depreciation is a P&L expense ──
       report_pnl leaves out an expense that became an asset (capitalised); the cost
       reaches the P&L only as depreciation (lib/accounting/depreciation.ts). */
    fetchAllRows((a, b) => supabase.from("fixed_assets")
      .select("id, name, block, cost, put_to_use, disposed_on, disposal_value")
      .order("id").range(a, b)),
    /* ── R-1852: a director-employee's payroll → the Director's Remuneration line ── */
    fetchDirectorPayroll(supabase),
  ]);

  const itemIds = [...new Set(subs.map((s) => s.item_id).filter((id): id is string => !!id))];
  const items = await fetchAllRowsIn(itemIds, (ids, a, b) =>
    supabase.from("items").select("id, wholesale").in("id", ids).order("id").range(a, b));
  const wholesaleById = new Map(items.map((i) => [i.id, i.wholesale ?? 0]));

  const book = subs.map((s) => ({
    vendor: String(s.vendor ?? "other"),
    seats: s.seats ?? 0,
    mrr: s.mrr ?? 0,
    wholesalePerSeatMonth: s.item_id ? (wholesaleById.get(s.item_id) ?? 0) : 0,
    startDate: s.start_date,
    renewalDate: s.renewal_date,
  }));
  const fixed: Omit<PnlMasters, "vendors"> = {
    allocations: labourRows.map((l) => ({ ...l, percent: Number(l.percent), months: Number(l.months) })),
    monthlyGross: new Map(emps.map((e) => [e.id, e.monthly_gross ?? 0])),
    projects,
    employeeNames: new Map(emps.map((e) => [e.id, e.name])),
    assets: assets.map((x) => ({ ...x, block: x.block as AssetBlock })),
    directorPayroll,
  };
  return (range: Range): PnlMasters => ({ ...fixed, vendors: vendorsFromSubscriptions(book, range.from, range.to) });
}

async function pnlFor(supabase: Client, range: Range, masters: (r: Range) => PnlMasters): Promise<PnLNumbers> {
  const [rpc, other] = await Promise.all([
    supabase.rpc("report_pnl", { p_from: range.from, p_to: range.to }),
    otherIncomeRows(supabase, range),
  ]);
  const row = rpcRowOrThrow<PnlRpcRow>(rpc, "report_pnl");
  return assemblePnl(range, { ...row, other_income: other }, masters(range));
}

type OtherIncomeRpc = (
  fn: "report_pnl_other_income", args: { p_from: string; p_to: string },
) => PromiseLike<{ data: { head: string; amount: number; n: number }[] | null; error: { code?: string; message: string } | null }>;

/**
 * R-2095: Other income (interest received / other, booked from bank lines) — companion of
 * report_pnl like report_pnl_revenue_by_product. On a database without the function the P&L shows
 * no Other income block (null), never a guessed figure.
 */
async function otherIncomeRows(supabase: Client, range: Range): Promise<{ head: string; amount: number; n: number }[] | null> {
  const rpc = supabase.rpc as unknown as OtherIncomeRpc;
  const { data, error } = await rpc.call(supabase, "report_pnl_other_income", { p_from: range.from, p_to: range.to });
  return error || !Array.isArray(data) ? null : data;
}

type RevenueByProductRpc = (
  fn: "report_pnl_revenue_by_product", args: { p_from: string; p_to: string },
) => PromiseLike<{ data: RevenueByProductRow[] | null; error: { code?: string; message: string } | null }>;

/**
 * R-1835: Revenue by what was sold — companion of report_pnl (migration 20261024110239).
 * Optional on purpose: on a database without the function, or when the call fails, the
 * statement keeps R-1833's Revenue lines (null here). The Revenue TOTAL never comes from here.
 */
async function revenueByProductRows(supabase: Client, range: Range): Promise<RevenueByProductRow[] | null> {
  const rpc = supabase.rpc as unknown as RevenueByProductRpc;
  const { data, error } = await rpc.call(supabase, "report_pnl_revenue_by_product", { p_from: range.from, p_to: range.to });
  return error || !Array.isArray(data) ? null : data;
}

export function usePnL(range: Range, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.pnl(), range.from, range.to],
    /* The comparison period is fetched only once the owner asks for it. A second full
       aggregation on every page load, for a number nobody is reading, is a cost with no
       reader. */
    enabled,
    queryFn: async (): Promise<PnLNumbers> => {
      const supabase = createClient();
      const [rpc, masters, byProduct, other] = await Promise.all([
        supabase.rpc("report_pnl", { p_from: range.from, p_to: range.to }),
        fetchPnlMasters(supabase),
        revenueByProductRows(supabase, range),
        otherIncomeRows(supabase, range),   // R-2095
      ]);
      const row = rpcRowOrThrow<PnlRpcRow>(rpc, "report_pnl");
      return assemblePnl(range, { ...row, revenue_by_product: byProduct, other_income: other }, masters(range));
    },
  });
}

/**
 * R-1647: the P&L of every FY month up to the current one — month key → that month's P&L, by
 * the same assemblePnl() as usePnL. The masters are read once; report_pnl runs per month (each
 * a small, indexed range) in parallel.
 */
export function usePnLMonths(fyStartYear: number, today: string, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.pnl(), "months", fyStartYear, today.slice(0, 7)],
    enabled,
    queryFn: async (): Promise<Map<string, PnLNumbers>> => {
      const supabase = createClient();
      const masters = await fetchPnlMasters(supabase);
      const months = fyMonthsSoFar(fyStartYear, today);
      const rows = await Promise.all(months.map((m) => pnlFor(supabase, monthRange(m.key), masters)));
      return new Map(months.map((m, i) => [m.key, rows[i]]));
    },
  });
}
