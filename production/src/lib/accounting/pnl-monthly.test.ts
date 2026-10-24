/**
 * R-1647 — the FY trend chart and "best / weakest month" read THE P&L of each month.
 *
 * Before: the page drew the trend from `report_pnl_monthly` (revenue and GST-inclusive
 * expenses only) with a licence-cost ratio taken from whatever range the page showed — no
 * commission, no depreciation, no input-credit rule, no per-vendor bills. A month on the chart
 * and the same month opened as "This month" printed different profits.
 *
 * Now: each point is assemblePnl() over that month and reportProfit() of it, so
 *   (1) a month's point equals that month's own P&L, and
 *   (2) the months add up to the FY P&L — every line that is additive over time (revenue, bills,
 *       expenses net of input credit, commission, depreciation) is the same rupees either way.
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, reportProfit, type PnlRpcRow, type PnlMasters, type PnLNumbers } from "./pnl-assemble";
import { monthlySeriesFromPnl, monthRange, fyMonthsSoFar, trendHighlights } from "./pnl-charts";
import type { AssetLike } from "./depreciation";

/* ── A small book of transactions, and a TS stand-in for report_pnl over any range ─── */
interface Inv { date: string; taxable: number; tax: number }
interface Exp { date: string; amount: number; gst: number; category: string; bill_type: string; gstin: string | null }
interface Bill { date: string; subtotal: number; category: string }
interface Comm { date: string; gross: number }

const GSTIN = "07AAACA1234A1Z5";
const invoices: Inv[] = [
  { date: "2026-04-10", taxable: 300_000, tax: 54_000 },
  { date: "2026-05-15", taxable: 120_000, tax: 21_600 },
  { date: "2026-06-02", taxable: 410_000, tax: 73_800 },
  { date: "2026-07-20", taxable: 95_000, tax: 17_100 },
];
const expenses: Exp[] = [
  { date: "2026-04-30", amount: 118_000, gst: 18_000, category: "Rent", bill_type: "gst", gstin: GSTIN },   // credit → ₹1,00,000 cost
  { date: "2026-05-30", amount: 90_000, gst: 0, category: "Salaries", bill_type: "none", gstin: null },
  { date: "2026-06-30", amount: 11_800, gst: 1_800, category: "Staff Welfare", bill_type: "gst", gstin: GSTIN },  // s.17(5): GST stays cost
  { date: "2026-07-05", amount: 160_000, gst: 0, category: "Salaries", bill_type: "none", gstin: null },
];
const bills: Bill[] = [
  { date: "2026-04-12", subtotal: 150_000, category: "COGS-Workspace" },
  { date: "2026-06-03", subtotal: 205_000, category: "COGS-Workspace" },
  { date: "2026-07-21", subtotal: 40_000, category: "COGS-Other" },
];
const commissions: Comm[] = [
  { date: "2026-05-16", gross: 12_000 },
  { date: "2026-06-04", gross: 41_000 },
];
const assets: AssetLike[] = [
  { id: "a1", name: "Laptop", block: "computers", cost: 90_000, put_to_use: "2026-05-10" },
];

const inR = (d: string, r: { from: string; to: string }) => d >= r.from && d <= r.to;

function rpcFor(r: { from: string; to: string }): PnlRpcRow {
  const inv = invoices.filter((x) => inR(x.date, r));
  const ex = expenses.filter((x) => inR(x.date, r));
  const bl = bills.filter((x) => inR(x.date, r));
  const cm = commissions.filter((x) => inR(x.date, r));
  const byCat = new Map<string, number>();
  for (const b of bl) byCat.set(b.category, (byCat.get(b.category) ?? 0) + b.subtotal);
  return {
    inv_taxable: inv.reduce((s, x) => s + x.taxable, 0),
    inv_tax: inv.reduce((s, x) => s + x.tax, 0),
    revenue_count: inv.length,
    cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
    revenue_by_project: [],
    cogs: bl.reduce((s, x) => s + x.subtotal, 0),
    cogs_count: bl.length,
    bills_gst: 0,
    bill_itc_groups: [],
    cogs_by_category: [...byCat.entries()].map(([category, subtotal]) => ({ category, subtotal, n: 1 })),
    expense_groups: ex.map((x) => ({ category: x.category, vendor_name: null, month: x.date.slice(0, 7), amount: x.amount, n: 1 })),
    itc_groups: ex.filter((x) => x.gst > 0).map((x) => ({ bill_type: x.bill_type, category: x.category, vendorGstin: x.gstin, gst_paid: x.gst, n: 1 })),
    unassigned_by_category: ex.map((x) => ({ category: x.category, amount: x.amount })),
    project_expenses: [],
    commissions: cm.reduce((s, x) => s + x.gross, 0),
    commissions_count: cm.length,
  };
}

/* The licence cost is billed (no subscription-book estimate), so every line is additive over
   time. An estimate is a RATIO of each period's own book and is not additive by nature — a
   month's point is still that month's own P&L (the second test), the FY sum may differ by it. */
const masters: PnlMasters = {
  vendors: [],
  allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(), assets,
};

const pnl = (r: { from: string; to: string }): PnLNumbers => assemblePnl(r, rpcFor(r), masters);
const FY = { from: "2026-04-01", to: "2027-03-31" };
const TODAY = "2026-08-18";

function series(today = TODAY) {
  const months = new Map(fyMonthsSoFar(2026, today).map((m) => [m.key, pnl(monthRange(m.key))]));
  return monthlySeriesFromPnl({ fyStartYear: 2026, today, months });
}

describe("R-1647: the trend reads each month's own P&L", () => {
  it("the twelve months add up to the FY P&L profit, to the rupee", () => {
    const fy = pnl(FY);
    const s = series("2027-04-10");          // the FY is over: all twelve months
    expect(s).toHaveLength(12);
    expect(s.reduce((a, p) => a + p.netProfit, 0)).toBe(reportProfit(fy));
    expect(s.reduce((a, p) => a + p.revenue, 0)).toBe(fy.model.revenue);
  });

  it("mid-year: the months so far add up to the FY-to-date P&L", () => {
    const fy = pnl({ from: FY.from, to: "2026-08-31" });
    /* The fixture exercises every line the old trend left out. */
    expect(fy.commissions).toBe(53_000);
    expect(fy.depreciation).toBeGreaterThan(0);
    expect(fy.model.cogsBasis).toBe("billed");
    const s = series();
    expect(s.reduce((a, p) => a + p.netProfit, 0)).toBe(reportProfit(fy));
    expect(s.reduce((a, p) => a + p.revenue, 0)).toBe(fy.model.revenue);
  });

  it("a month's point is exactly the P&L of that month alone", () => {
    for (const p of series()) {
      const own = pnl(monthRange(p.key));
      expect(p.netProfit).toBe(reportProfit(own));
      expect(p.revenue - p.cogs - p.expenses).toBe(p.netProfit);
    }
  });

  it("June carries its commission, its blocked GST and its depreciation (the old trend did not)", () => {
    const jun = series().find((p) => p.key === "2026-06")!;
    const own = pnl({ from: "2026-06-01", to: "2026-06-30" });
    /* Revenue 4,10,000 − bill 2,05,000 − staff welfare 11,800 (GST blocked, stays cost)
       − commission 41,000 − June's depreciation. */
    expect(jun.netProfit).toBe(410_000 - 205_000 - 11_800 - 41_000 - own.depreciation);
  });

  it("April's rent is a cost net of its input credit, not the GST-inclusive amount", () => {
    const apr = series().find((p) => p.key === "2026-04")!;
    expect(apr.netProfit).toBe(300_000 - 150_000 - 100_000);
  });

  it("best / weakest month are judged on those same profits", () => {
    const s = series();
    const { best, worst } = trendHighlights(s);
    const done = s.filter((p) => !p.partial && (p.revenue !== 0 || p.expenses !== 0));
    expect(best!.netProfit).toBe(Math.max(...done.map((p) => p.netProfit)));
    expect(worst!.netProfit).toBe(Math.min(...done.map((p) => p.netProfit)));
  });

  it("stops at the current month and marks it running", () => {
    const s = series();
    expect(s.map((p) => p.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug"]);
    expect(s.at(-1)!.partial).toBe(true);
  });

  it("monthRange covers the whole calendar month", () => {
    expect(monthRange("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    expect(monthRange("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
