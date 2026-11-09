// @vitest-environment jsdom
/**
 * R-2624 — usePnL / usePnLMonths read the spread revenue on Management only.
 *   GST view: no report_pnl_revenue_matched call, revenue as invoiced (₹12,000 in October).
 *   Management: revenue from report_pnl_revenue_matched (₹1,000 = 1/12); output GST as invoiced.
 *   A database without the revenue function: matched COGS kept, revenue as invoiced, marked.
 */
import * as React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ calls: [] as string[], revenueError: null as null | { code: string; message: string } }));

const ROW = {
  inv_taxable: 12_000, inv_tax: 2_160, revenue_count: 1, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, bill_itc_groups: [], cogs_by_category: [],
  expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
};
const REV = { inv_taxable: 1_000, cn_taxable: 0, dn_taxable: 0, revenue_count: 1,
  by_product: [{ family: "google", invoiced: 1_000, credit_notes: 0, debit_notes: 0, invoice_count: 1 }] };

vi.mock("@/lib/supabase/client", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "neq", "order", "eq", "in", "gte", "lte"]) q[m] = () => q;
    q.range = () => Promise.resolve({ data: [], error: null });
    return q;
  };
  return {
    createClient: () => ({
      rpc(fn: string) {
        state.calls.push(fn);
        if (fn === "report_pnl") return Promise.resolve({ data: [ROW], error: null });
        if (fn === "report_pnl_cogs_matched") return Promise.resolve({ data: [{ cogs: 0, cogs_count: 0, cogs_by_category: [], bills: [] }], error: null });
        if (fn === "report_pnl_revenue_matched_months") {
          return Promise.resolve({ data: [{ month: "2026-04-01", ...REV }, { month: "2026-05-01", ...REV }], error: null });
        }
        if (fn === "report_pnl_revenue_matched") {
          return Promise.resolve(state.revenueError ? { data: null, error: state.revenueError } : { data: [REV], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      from: () => chain(),
    }),
  };
});
vi.mock("@/lib/queries/director-payroll", () => ({ fetchDirectorPayroll: () => Promise.resolve([]) }));

import { usePnL, usePnLMonths } from "./pnl";

const OCT = { from: "2026-10-01", to: "2026-10-31" };
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { Wrapper };
}

beforeEach(() => { state.calls = []; state.revenueError = null; });

describe("R-2624 usePnL revenue spread", () => {
  it("GST view: no revenue spread call, ₹12,000 in October", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(OCT), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(state.calls).not.toContain("report_pnl_revenue_matched");
    expect(result.current.data!.revenue).toBe(12_000);
  });

  it("Management: 1/12 of the yearly invoice in October; output GST as invoiced", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(OCT, true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const d = result.current.data!;
    expect(d.revenue).toBe(1_000);
    expect(d.revenueSpread).toBe(true);
    expect(d.outputGST).toBe(2_160);
    expect(d.revenueByProduct?.[0]).toMatchObject({ family: "google", net: 1_000 });
  });

  it("revenue rpc missing: revenue as invoiced, marked; another error is an error", async () => {
    state.revenueError = { code: "PGRST202", message: "Could not find the function" };
    const a = wrap();
    const { result } = renderHook(() => usePnL(OCT, true, "management"), { wrapper: a.Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.revenue).toBe(12_000);
    expect(result.current.data!.managementRevenueUnavailable).toBe(true);

    state.revenueError = { code: "57014", message: "statement timeout" };
    const b = wrap();
    const { result: r2 } = renderHook(() => usePnL(OCT, true, "management"), { wrapper: b.Wrapper });
    await waitFor(() => expect(r2.current.isError).toBe(true));
  });

  it("months use the spread too on Management — ONE months call, not one per month (checker BLOCK)", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnLMonths(2026, "2026-05-31", true, "management")   /* R-2625: both months over (a current month is read to today on its own) */, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(state.calls.filter((c) => c === "report_pnl_revenue_matched_months")).toHaveLength(1);
    expect(state.calls).not.toContain("report_pnl_revenue_matched");
    expect([...result.current.data!.values()].every((p) => p.revenue === 1_000)).toBe(true);
  });
});
