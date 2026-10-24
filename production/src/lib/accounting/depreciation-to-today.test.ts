/**
 * R-1808 — the P&L's "This FY" runs to 31 Mar, so depreciation was charged for months that have
 * not happened yet. Every report now stops depreciation at min(range end, today IST).
 *
 * "Today" here is 24 Oct 2026, mid-year. The callers are the ones the reports use:
 *   · registerDepreciationForRange — P&L (pnl-assemble.ts, reports-reference.ts), and through
 *     assemblePnl the Balance Sheet's profit, the Trial Balance and the R-1647 monthly trend;
 *   · netBlockAt — the Balance Sheet / Trial Balance accumulated depreciation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerDepreciationForRange, netBlockAt, accumulatedDepreciation, depreciationForRange, type AssetLike } from "./depreciation";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";
import { monthRange } from "./pnl-charts";

/* ₹1,00,000 laptop in use all FY 2026-27 (bought last year): 40% WDV block. */
const laptop: AssetLike = { id: "fa1", name: "Laptop", block: "computers", cost: 100_000, put_to_use: "2025-04-01" };
const TODAY = "2026-10-24";
const FY = { from: "2026-04-01", to: "2027-03-31" };

const row = (): PnlRpcRow => ({
  inv_taxable: 0, inv_tax: 0, revenue_count: 0, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0, expense_groups: [], itc_groups: [],
  unassigned_by_category: [], project_expenses: [], commissions: 0, commissions_count: 0,
});
const masters = (): PnlMasters => ({
  vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(), assets: [laptop],
});

afterEach(() => vi.useRealTimers());

describe("R-1808: depreciation stops at today (IST), never charged for future months", () => {
  it("This FY on 24 Oct = 1 Apr → 24 Oct, not the whole year", () => {
    const toToday = depreciationForRange(laptop, FY.from, TODAY);
    expect(toToday).toBeLessThan(depreciationForRange(laptop, FY.from, FY.to));
    expect(registerDepreciationForRange([laptop], FY.from, FY.to, TODAY)).toBe(toToday);
    // a range already in the past is unchanged
    expect(registerDepreciationForRange([laptop], "2026-04-01", "2026-09-30", TODAY))
      .toBe(depreciationForRange(laptop, "2026-04-01", "2026-09-30"));
    // a range wholly in the future charges nothing
    expect(registerDepreciationForRange([laptop], "2026-11-01", "2026-11-30", TODAY)).toBe(0);
  });

  it("the current month (R-1647 trend) charges only up to today", () => {
    const oct = monthRange("2026-10");
    expect(registerDepreciationForRange([laptop], oct.from, oct.to, TODAY))
      .toBe(depreciationForRange(laptop, "2026-10-01", TODAY));
  });

  it("Balance Sheet / Trial Balance accumulated depreciation stops at today too", () => {
    expect(netBlockAt([laptop], "2027-03-31", TODAY).accumulated).toBe(accumulatedDepreciation(laptop, TODAY));
    expect(netBlockAt([laptop], "2026-09-30", TODAY).accumulated).toBe(accumulatedDepreciation(laptop, "2026-09-30"));
  });

  it("default 'today' is IST today — the P&L (assemblePnl) for This FY on 24 Oct", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T06:00:00Z"));          // 11:30 IST, 24 Oct
    const p = assemblePnl(FY, row(), masters());
    expect(p.depreciation).toBe(depreciationForRange(laptop, FY.from, TODAY));
    expect(p.netProfit).toBe(-p.depreciation);
    // 23 Oct 20:00 UTC is already 24 Oct 01:30 in India — IST, not UTC
    vi.setSystemTime(new Date("2026-10-23T20:00:00Z"));
    expect(registerDepreciationForRange([laptop], FY.from, FY.to)).toBe(depreciationForRange(laptop, FY.from, TODAY));
  });
});
