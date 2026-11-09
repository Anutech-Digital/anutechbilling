// @vitest-environment jsdom
/**
 * R-2625 — the hooks behind "no revenue for months that have not happened" and the Balance Sheet's
 * Advance billing.
 *   usePnL Management, This FY in November: revenue from report_pnl_revenue_matched(1 Apr, 30 Nov);
 *     the later months' part read separately (note only, not in any total).
 *   This month: one call, whole month (revenue and cost of goods on the same days, as R-2624).
 *   A range wholly after this month: ₹0, no counted call.
 *   GST view: no cap, no matched call, the old query key (Balance Sheet / Trial Balance share it).
 *   usePnLMonths: unchanged — ONE months call (R-2624), no per-month calls.
 *   useAdvanceBilling: report_pnl and report_pnl_revenue_matched over the SAME dates; invoiced − earned to TODAY.
 */
import * as React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  revenueError: null as null | { code: string; message: string },
}));

const ROW = {
  inv_taxable: 12_000, inv_tax: 2_160, revenue_count: 1, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
  expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
};
const rev = (n: number) => ({ inv_taxable: n, cn_taxable: 0, dn_taxable: 0, revenue_count: 1,
  by_product: [{ family: "google", invoiced: n, credit_notes: 0, debit_notes: 0, invoice_count: 1 }] });

vi.mock("@/lib/supabase/client", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "neq", "order", "eq", "in", "gte", "lte"]) q[m] = () => q;
    q.range = () => Promise.resolve({ data: [], error: null });
    return q;
  };
  return {
    createClient: () => ({
      rpc(fn: string, args: Record<string, unknown>) {
        state.calls.push({ fn, args });
        if (fn === "report_pnl") return Promise.resolve({ data: [ROW], error: null });
        if (fn === "report_pnl_cogs_matched") return Promise.resolve({ data: [{ cogs: 0, cogs_count: 0, cogs_by_category: [], bills: [] }], error: null });
        if (fn === "report_pnl_revenue_matched_months") {
          return Promise.resolve({ data: [{ month: "2026-04-01", ...rev(1_000) }], error: null });
        }
        if (fn === "report_pnl_revenue_matched") {
          if (state.revenueError) return Promise.resolve({ data: null, error: state.revenueError });
          // later months (Dec..Mar) = 4,000; to 30 Nov = 2,000; to today (9 Nov, the Balance Sheet) = 1,300
          const n = args.p_from === "2026-12-01" || args.p_from === "2027-03-01" ? 4_000 : args.p_to === "2026-11-09" ? 1_300 : 2_000;
          return Promise.resolve({ data: [rev(n)], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      from: () => chain(),
    }),
  };
});
vi.mock("@/lib/queries/director-payroll", () => ({ fetchDirectorPayroll: () => Promise.resolve([]) }));

import { usePnL, usePnLMonths, useAdvanceBilling } from "./pnl";

const TODAY = "2026-11-09";
const FY = { from: "2026-04-01", to: "2027-03-31" };
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, Wrapper };
}
const matchedCalls = () => state.calls.filter((c) => c.fn === "report_pnl_revenue_matched").map((c) => c.args);

beforeEach(() => { state.calls = []; state.revenueError = null; });

describe("R-2625 usePnL — no Management revenue for months that have not happened", () => {
  it("This FY in November: revenue to 30 Nov; Dec..Mar is 'not earned yet', not in revenue", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(FY, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual(expect.arrayContaining([
      { p_from: "2026-04-01", p_to: "2026-11-30" },
      { p_from: "2026-12-01", p_to: "2027-03-31" },
    ]));
    expect(matchedCalls()).toHaveLength(2);
    const d = result.current.data!;
    expect(d.revenue).toBe(2_000);
    expect(d.revenueEarnedTo).toBe("2026-11-30");
    expect(d.revenueNotYetEarned).toBe(4_000);
  });

  it("This month (November) mid-month: ONE call for the whole month, no note — same days as cost of goods", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL({ from: "2026-11-01", to: "2026-11-30" }, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual([{ p_from: "2026-11-01", p_to: "2026-11-30" }]);
    expect(state.calls.find((c) => c.fn === "report_pnl_cogs_matched")!.args).toEqual({ p_from: "2026-11-01", p_to: "2026-11-30" });
    expect(result.current.data!.revenueEarnedTo).toBeUndefined();
  });

  it("a month wholly after this month: ₹0, only the not-yet call", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL({ from: "2027-03-01", to: "2027-03-31" }, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual([{ p_from: "2027-03-01", p_to: "2027-03-31" }]);
    expect(result.current.data!.revenue).toBe(0);
    expect(result.current.data!.revenueSpread).toBe(true);
  });

  it("a past month: one call, no cap", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL({ from: "2026-10-01", to: "2026-10-31" }, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual([{ p_from: "2026-10-01", p_to: "2026-10-31" }]);
    expect(result.current.data!.revenueEarnedTo).toBeUndefined();
  });

  it("missing revenue function: revenue as invoiced, marked (no cap figures)", async () => {
    state.revenueError = { code: "PGRST202", message: "Could not find the function" };
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(FY, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.revenue).toBe(12_000);
    expect(result.current.data!.managementRevenueUnavailable).toBe(true);
    expect(result.current.data!.revenueEarnedTo).toBeUndefined();
  });

  it("GST view: not cut, no matched call, the same query key as before", async () => {
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(FY, true, "gst", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual([]);
    expect(result.current.data!.revenue).toBe(12_000);
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([["accounting", "pnl", "2026-04-01", "2027-03-31"]]);
  });
});

describe("R-2625 usePnLMonths — unchanged: ONE months call up to the current month", () => {
  it("mid-month: one months call Apr..Nov, no per-month revenue calls", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnLMonths(2026, TODAY, true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const months = state.calls.filter((c) => c.fn === "report_pnl_revenue_matched_months").map((c) => c.args);
    expect(months).toEqual([{ p_from: "2026-04-01", p_to: "2026-11-30" }]);
    expect(matchedCalls()).toEqual([]);
    expect(result.current.data!.get("2026-04")!.revenue).toBe(1_000);
  });
});

describe("R-2625 useAdvanceBilling — invoiced to date − earned to date", () => {
  it("both reports over the SAME dates (books start fallback .. as-of); 12,000 − 1,300 = 10,700", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAdvanceBilling(TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const pnl = state.calls.find((c) => c.fn === "report_pnl")!.args;
    const earned = matchedCalls();
    expect(earned).toEqual([pnl]);
    expect(pnl).toEqual({ p_from: "2000-04-01", p_to: TODAY });
    expect(result.current.data).toEqual({ advance: 10_700, invoiced: 12_000, earned: 1_300 });
  });

  it("missing revenue function → null (no card); another error → error", async () => {
    state.revenueError = { code: "42883", message: "function does not exist" };
    const a = wrap();
    const { result } = renderHook(() => useAdvanceBilling(TODAY), { wrapper: a.Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();

    state.revenueError = { code: "57014", message: "statement timeout" };
    const b = wrap();
    const { result: r2 } = renderHook(() => useAdvanceBilling(TODAY), { wrapper: b.Wrapper });
    await waitFor(() => expect(r2.current.isError).toBe(true));
  });
});
