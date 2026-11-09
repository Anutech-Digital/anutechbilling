// @vitest-environment jsdom
/**
 * R-2622 — usePnL / usePnLMonths on the asked basis.
 *   GST view: only report_pnl (no matched call), numbers exactly as before, same query key as before
 *   (the Balance Sheet / Trial Balance read it — they never ask for Management).
 *   Management: report_pnl_cogs_matched swaps the COGS bills; a database without it → the GST
 *   numbers, marked managementUnavailable (the page says so) — never a silent mix.
 */
import * as React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ calls: [] as string[], matchedError: false }));

const ROW = {
  inv_taxable: 200_000, inv_tax: 36_000, revenue_count: 4, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 1_033_617, cogs_count: 1, bills_gst: 0, bill_itc_groups: [],
  cogs_by_category: [{ category: "COGS-Workspace", subtotal: 1_033_617, n: 1 }],
  expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
};
const SUBS = [{ id: "s1", vendor: "google", seats: 100, mrr: 100_000, start_date: "2026-01-01", renewal_date: null, item_id: "i1", status: "active" }];

vi.mock("@/lib/supabase/client", () => {
  const chain = (data: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "neq", "order", "eq", "in", "gte", "lte"]) q[m] = () => q;
    q.range = (a: number) => Promise.resolve({ data: a === 0 ? data : [], error: null });
    return q;
  };
  return {
    createClient: () => ({
      rpc(fn: string) {
        state.calls.push(fn);
        if (fn === "report_pnl") return Promise.resolve({ data: [ROW], error: null });
        if (fn === "report_pnl_cogs_matched") {
          return Promise.resolve(state.matchedError
            ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
            : { data: [{ cogs: 0, cogs_count: 0, cogs_by_category: [], bills: [] }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      from: (t: string) => chain(t === "subscriptions" ? SUBS : t === "items" ? [{ id: "i1", wholesale: 700 }] : []),
    }),
  };
});
vi.mock("@/lib/queries/director-payroll", () => ({ fetchDirectorPayroll: () => Promise.resolve([]) }));

import { usePnL, usePnLMonths } from "./pnl";

const OCT = { from: "2026-10-01", to: "2026-10-31" };
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, Wrapper };
}

beforeEach(() => { state.calls = []; state.matchedError = false; });

describe("R-2622 usePnL basis", () => {
  it("GST view (the default): no matched call, the bill counts on its date, the old query key", async () => {
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(OCT), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(state.calls).not.toContain("report_pnl_cogs_matched");
    expect(result.current.data!.model.billedLicenceCogs).toBe(1_033_617);
    expect(result.current.data!.basis).toBeUndefined();
    expect(qc.getQueryCache().getAll().map((q) => q.queryKey.at(-1))).toContain("2026-10-31");
  });

  it("Management: the matched call replaces the COGS bills — October has no Google bill, Google is estimated", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(OCT, true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(state.calls).toContain("report_pnl_cogs_matched");
    const d = result.current.data!;
    expect(d.basis).toBe("management");
    expect(d.model.billedLicenceCogs).toBe(0);
    expect(d.model.estimatedLicenceCogs).toBeGreaterThan(0);
    expect(d.model.cogsBasis).toBe("estimated");
  });

  it("rpc missing falls back: Management on an older database shows GST numbers, marked", async () => {
    state.matchedError = true;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnL(OCT, true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.managementUnavailable).toBe(true);
    expect(result.current.data!.basis).toBe("gst");
    expect(result.current.data!.model.billedLicenceCogs).toBe(1_033_617);
  });

  it("months use basis: the FY trend asks the matched RPC once per month on Management", async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePnLMonths(2026, "2026-06-15", true, "management"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(state.calls.filter((c) => c === "report_pnl_cogs_matched")).toHaveLength(3);   // Apr, May, Jun
    expect([...result.current.data!.values()].every((p) => p.basis === "management")).toBe(true);
  });
});
