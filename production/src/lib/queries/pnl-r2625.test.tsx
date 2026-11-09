// @vitest-environment jsdom
/**
 * R-2625 — the hooks behind "earned only up to today" and the Balance Sheet's Advance billing.
 *   usePnL Management, This FY in November: revenue from report_pnl_revenue_matched(1 Apr, today);
 *     the later days' part read separately (note only, not in any total).
 *   A range wholly after today: ₹0 earned, no earned call.
 *   GST view: no cap, no matched call, the old query key (Balance Sheet / Trial Balance share it).
 *   usePnLMonths: the months already over in ONE call; the current month to today.
 *   useAdvanceBilling: report_pnl and report_pnl_revenue_matched over the SAME dates; invoiced − earned.
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
          // earned part to today = 1,300 (Oct 1,000 + 9 days of Nov); the later days = 4,700
          return Promise.resolve({ data: [rev(args.p_from === "2026-11-10" ? 4_700 : 1_300)], error: null });
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

describe("R-2625 usePnL — Management revenue is earned only up to today", () => {
  it("This FY in November: revenue to today; the rest is 'not earned yet', not in revenue", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(FY, true, "management", TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(matchedCalls()).toEqual(expect.arrayContaining([
      { p_from: "2026-04-01", p_to: "2026-11-09" },
      { p_from: "2026-11-10", p_to: "2027-03-31" },
    ]));
    const d = result.current.data!;
    expect(d.revenue).toBe(1_300);
    expect(d.revenueEarnedTo).toBe(TODAY);
    expect(d.revenueNotYetEarned).toBe(4_700);
  });

  it("a month wholly after today: ₹0 earned, only the not-yet call", async () => {
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

describe("R-2625 usePnLMonths — the current month to today", () => {
  it("months over in ONE call; the current month (Nov) earned to 9 Nov", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnLMonths(2026, TODAY, true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const months = state.calls.filter((c) => c.fn === "report_pnl_revenue_matched_months").map((c) => c.args);
    expect(months).toEqual([{ p_from: "2026-04-01", p_to: "2026-10-31" }]);
    expect(matchedCalls()).toEqual(expect.arrayContaining([{ p_from: "2026-11-01", p_to: "2026-11-09" }]));
    expect(result.current.data!.get("2026-11")!.revenue).toBe(1_300);
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
