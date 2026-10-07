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
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { vendorsFromSubscriptions } from "@/lib/accounting/pnl";
import { assemblePnl, type PnLNumbers, type PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import { rpcRowOrThrow } from "@/lib/accounting/report-rpc";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";

export type { PnLNumbers } from "@/lib/accounting/pnl-assemble";

/** Wide enough to hold every entry the books have; the Balance Sheet reads profit from here. */
export const BOOKS_START = "2000-04-01";

export function usePnL(range: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: ["accounting", "pnl", range.from, range.to],
    /* The comparison period is fetched only once the owner asks for it. A second full
       aggregation on every page load, for a number nobody is reading, is a cost with no
       reader. */
    enabled,
    queryFn: async (): Promise<PnLNumbers> => {
      const supabase = createClient();

      /* R-265: the master-data reads page with fetchAllRows on `id` — a bare select stops
         at PostgREST's 1000-row cap and the subscription cost / project cost would silently
         cover only the first 1000 rows. fetchAllRows throws a page's error itself. */
      const [rpc, subs, labourRows, emps, projects] = await Promise.all([
        supabase.rpc("report_pnl", { p_from: range.from, p_to: range.to }),
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
           expenses into cost of goods — moved, never added (lib/accounting/project-cost.ts). */
        fetchAllRows((a, b) => supabase.from("project_labour")
          .select("id, project_id, employee_id, percent, months, start_date, end_date")
          .order("id").range(a, b)),
        fetchAllRows((a, b) => supabase.from("employees").select("id, name, monthly_gross").order("id").range(a, b)),
        fetchAllRows((a, b) => supabase.from("project_sales").select("id, title, customer_name, start_date").order("id").range(a, b)),
      ]);
      const row = rpcRowOrThrow<PnlRpcRow>(rpc, "report_pnl");

      const itemIds = [...new Set(subs.map((s) => s.item_id).filter((id): id is string => !!id))];
      const items = await fetchAllRowsIn(itemIds, (ids, a, b) =>
        supabase.from("items").select("id, wholesale").in("id", ids).order("id").range(a, b));
      const wholesaleById = new Map(items.map((i) => [i.id, i.wholesale ?? 0]));

      const vendors = vendorsFromSubscriptions(
        subs.map((s) => ({
          vendor: String(s.vendor ?? "other"),
          seats: s.seats ?? 0,
          mrr: s.mrr ?? 0,
          wholesalePerSeatMonth: s.item_id ? (wholesaleById.get(s.item_id) ?? 0) : 0,
          startDate: s.start_date,
          renewalDate: s.renewal_date,
        })),
        range.from, range.to,
      );

      return assemblePnl(range, row, {
        vendors,
        allocations: labourRows.map((l) => ({ ...l, percent: Number(l.percent), months: Number(l.months) })),
        monthlyGross: new Map(emps.map((e) => [e.id, e.monthly_gross ?? 0])),
        projects,
        employeeNames: new Map(emps.map((e) => [e.id, e.name])),
      });
    },
  });
}
