import { describe, it, expect } from "vitest";
import {
  profitContribution, fyMonths, monthlySeriesFromPnl, trendHighlights, type MonthPnl,
} from "./pnl-charts";
import { buildPnl, vendorLine, type VendorInput } from "./pnl";

/* R-1647: the series is built from each month's own P&L (pnl-monthly.test.ts checks it against
   assemblePnl). These tests are about the series' shape and the highlights, so a month's P&L is
   made here from three numbers through buildPnl — revenue, a billed cost, expenses. */
interface MonthlyRow { date: string; amount: number }
function monthlySeries(args: {
  fyStartYear: number; revenue: readonly MonthlyRow[]; expenses: readonly MonthlyRow[]; cogsRatio: number; today: string;
}) {
  const sum = (rows: readonly MonthlyRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) ?? 0) + r.amount);
    return m;
  };
  const rev = sum(args.revenue), exp = sum(args.expenses);
  const months = new Map<string, MonthPnl>();
  for (const key of new Set([...rev.keys(), ...exp.keys()])) {
    const r = rev.get(key) ?? 0, e = exp.get(key) ?? 0, c = Math.round(r * args.cogsRatio);
    months.set(key, { revenue: r, cogs: c, netProfit: r - c - e, model: buildPnl({ revenue: r, expenses: e, billedCogs: c > 0 ? c : null, vendors: [] }) });
  }
  return monthlySeriesFromPnl({ fyStartYear: args.fyStartYear, today: args.today, months });
}

const line = (over: Partial<VendorInput>) => vendorLine({
  vendor: "google", revenue: 55_194, billedCost: null, estimatedCost: 35_283,
  seats: 199, subscriptions: 9, ...over,
});

/** ANUTECH's book: Google ₹19,911 gross on ₹55,194; support ₹1,225 gross on ₹1,225. */
const LIVE = [
  line({}),
  line({ vendor: "support", revenue: 1_225, estimatedCost: 0, seats: 4, subscriptions: 4 }),
];

/**
 * ─── WHY THE DONUT SHOWS PROFIT, NOT REVENUE ────────────────────────────────
 * A revenue donut for a reseller is one colour: Google is 98% of the book. Profit
 * contribution is the question worth a chart — support is 2% of sales and carries a 100%
 * margin, so it earns a share of the profit several times its share of the revenue.
 */
describe("profit contribution", () => {
  const { slices, totalGross } = profitContribution(LIVE);

  it("totals the gross profit, not the revenue", () => {
    expect(totalGross).toBe(19_911 + 1_225);
  });

  it("gives each vendor its share of the PROFIT", () => {
    const g = slices.find((s) => s.vendor === "google")!;
    const s = slices.find((s) => s.vendor === "support")!;
    expect(g.sharePct).toBe(94);
    expect(s.sharePct).toBe(6);
  });

  it("carries the revenue share too, so the two can be compared", () => {
    /* This is the whole point: support is 2% of sales and 6% of profit. */
    const s = slices.find((x) => x.vendor === "support")!;
    expect(s.revenueSharePct).toBe(2);
    expect(s.sharePct).toBeGreaterThan(s.revenueSharePct);
  });

  it("flags the vendor punching above its weight", () => {
    expect(slices.find((s) => s.vendor === "support")!.punchesAbove).toBe(true);
    expect(slices.find((s) => s.vendor === "google")!.punchesAbove).toBe(false);
  });

  it("does not call a one-point gap a signal — that is rounding", () => {
    const even = profitContribution([
      line({ vendor: "google", revenue: 100, estimatedCost: 50 }),
      line({ vendor: "zoho", revenue: 100, estimatedCost: 50 }),
    ]);
    for (const s of even.slices) expect(s.punchesAbove).toBe(false);
  });

  it("orders biggest contributor first", () => {
    expect(slices.map((s) => s.vendor)).toEqual(["google", "support"]);
  });
});

/**
 * ─── A LOSS CANNOT BE A SLICE ───────────────────────────────────────────────
 * There is no such thing as −15% of a circle. The usual "fix" is Math.abs, which turns a
 * loss into a healthy-looking wedge — the single most dishonest thing a pie chart can do.
 */
describe("a loss-making vendor", () => {
  const withLoss = [
    line({}),
    line({ vendor: "zoho", revenue: 10_000, estimatedCost: 14_000, seats: 5, subscriptions: 1 }),
  ];

  it("is kept OUT of the ring", () => {
    const { slices } = profitContribution(withLoss);
    expect(slices.map((s) => s.vendor)).not.toContain("zoho");
  });

  it("is returned separately so it can be said in words", () => {
    const { losing } = profitContribution(withLoss);
    expect(losing).toHaveLength(1);
    expect(losing[0].gross).toBe(-4_000);
    expect(losing[0].label).toBe("Zoho");
  });

  it("does not distort the shares of the vendors that DO make money", () => {
    /* Google is still 100% of the profit actually earned. Including the loss in the
       denominator would inflate its slice to more than the ring. */
    const { slices } = profitContribution([
      line({}),
      line({ vendor: "zoho", revenue: 10_000, estimatedCost: 14_000 }),
    ]);
    expect(slices).toHaveLength(1);
    expect(slices[0].sharePct).toBe(100);
  });

  it("survives a book where nobody makes money", () => {
    const { slices, losing, totalGross } = profitContribution([
      line({ vendor: "zoho", revenue: 1_000, estimatedCost: 2_000 }),
    ]);
    expect(slices).toEqual([]);
    expect(losing).toHaveLength(1);
    expect(totalGross).toBe(0);
  });
});

describe("the financial year's months", () => {
  it("runs Apr → Mar, not Jan → Dec", () => {
    const m = fyMonths(2026);
    expect(m[0]).toEqual({ key: "2026-04", label: "Apr" });
    expect(m[11]).toEqual({ key: "2027-03", label: "Mar" });
    expect(m).toHaveLength(12);
  });

  it("rolls the calendar year over at January", () => {
    const m = fyMonths(2026);
    expect(m.find((x) => x.label === "Dec")!.key).toBe("2026-12");
    expect(m.find((x) => x.label === "Jan")!.key).toBe("2027-01");
  });
});

describe("the monthly trend", () => {
  const revenue: MonthlyRow[] = [
    { date: "2026-04-10", amount: 100_000 },
    { date: "2026-04-25", amount: 50_000 },
    { date: "2026-06-01", amount: 200_000 },
    { date: "2026-08-17", amount: 914_376 },
  ];
  const expenses: MonthlyRow[] = [
    { date: "2026-04-30", amount: 60_000 },
    { date: "2026-05-30", amount: 60_000 },
    { date: "2026-06-30", amount: 60_000 },
    { date: "2026-08-01", amount: 275_551 },
  ];
  const series = monthlySeries({
    fyStartYear: 2026, revenue, expenses, cogsRatio: 0.625, today: "2026-08-18",
  });

  it("stops at the current month — no flat line into the future", () => {
    /* A line falling to the floor for the rest of the year is a picture of a business
       that has stopped, and it is the first thing the eye goes to. */
    expect(series.map((p) => p.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug"]);
  });

  it("sums several rows in the same month", () => {
    expect(series.find((p) => p.label === "Apr")!.revenue).toBe(150_000);
  });

  it("applies the SAME cost ratio the headline uses", () => {
    /* Deriving the monthly cost any other way gives a trend that disagrees with the
       waterfall above it. */
    const aug = series.find((p) => p.label === "Aug")!;
    expect(aug.cogs).toBe(Math.round(914_376 * 0.625));
  });

  it("computes net profit as revenue − cost − expenses", () => {
    const aug = series.find((p) => p.label === "Aug")!;
    expect(aug.netProfit).toBe(914_376 - aug.cogs - 275_551);
  });

  it("marks the current month as still running", () => {
    expect(series.find((p) => p.label === "Aug")!.partial).toBe(true);
    expect(series.find((p) => p.label === "Jul")!.partial).toBe(false);
  });

  it("returns NULL margin for a month with no revenue, never a huge negative", () => {
    /* May invoiced nothing and still paid ₹60,000 of salary. A margin there is
       arithmetically true, visually a cliff, and drags the other months off the chart. */
    const may = series.find((p) => p.label === "May")!;
    expect(may.revenue).toBe(0);
    expect(may.marginPct).toBeNull();
    expect(may.netProfit).toBe(-60_000);   // the rupees are still reported
  });

  it("keeps every figure a whole rupee", () => {
    for (const p of series) {
      for (const n of [p.revenue, p.cogs, p.expenses, p.netProfit]) {
        expect(Number.isInteger(n)).toBe(true);
      }
    }
  });

  it("includes a month with expenses but no revenue at all", () => {
    /* Dropping it would hide the months that lost money — the ones worth seeing. */
    expect(series.map((p) => p.label)).toContain("May");
  });
});

describe("trend highlights", () => {
  const series = monthlySeries({
    fyStartYear: 2026,
    revenue: [{ date: "2026-04-10", amount: 300_000 }, { date: "2026-06-01", amount: 100_000 }],
    expenses: [{ date: "2026-05-30", amount: 80_000 }],
    cogsRatio: 0.5,
    today: "2026-08-18",
  });

  it("names the best and worst finished months", () => {
    const { best, worst } = trendHighlights(series);
    expect(best!.label).toBe("Apr");
    expect(worst!.label).toBe("May");
  });

  it("counts the months that lost money", () => {
    expect(trendHighlights(series).lossMonths).toBeGreaterThan(0);
  });

  it("never calls the CURRENT month the worst — it has not finished", () => {
    /* Judging an unfinished month against complete ones is a verdict on data that has
       not arrived. */
    const partialWorst = monthlySeries({
      fyStartYear: 2026,
      revenue: [{ date: "2026-04-10", amount: 300_000 }],
      expenses: [{ date: "2026-08-01", amount: 900_000 }],
      cogsRatio: 0.5, today: "2026-08-18",
    });
    expect(trendHighlights(partialWorst).worst!.label).not.toBe("Aug");
  });

  it("returns nulls rather than throwing on an empty year", () => {
    const { best, worst, lossMonths } = trendHighlights([]);
    expect(best).toBeNull();
    expect(worst).toBeNull();
    expect(lossMonths).toBe(0);
  });
});

/**
 * ─── AN EMPTY MONTH IS NOT A GOOD MONTH ─────────────────────────────────────
 * Caught by reading the live chart, not by reasoning about it. The page said
 * "Best month so far was May at ₹0 net" while three other months lost money —
 * arithmetically true (0 > negative) and useless. May had no invoices and no expenses.
 * A month where nothing happened is not a business result.
 */
describe("months with no activity are not results", () => {
  const series = monthlySeries({
    fyStartYear: 2026,
    /* Apr trades and loses; May is silent; Jun trades and wins. */
    revenue:  [{ date: "2026-04-10", amount: 100_000 }, { date: "2026-06-10", amount: 400_000 }],
    expenses: [{ date: "2026-04-28", amount: 120_000 }, { date: "2026-06-28", amount: 50_000 }],
    cogsRatio: 0.5, today: "2026-08-18",
  });

  it("does not crown an empty month as the best", () => {
    const { best } = trendHighlights(series);
    expect(best!.label).not.toBe("May");
    expect(best!.label).toBe("Jun");
  });

  it("does not blame an empty month as the worst either", () => {
    expect(trendHighlights(series).worst!.label).toBe("Apr");
  });

  it("still PLOTS the empty month — the gap is the information", () => {
    /* Excluding it from best/worst is a judgement about ranking, not about drawing. A
       missing bar would hide a month with no sales, which is worth seeing. */
    expect(series.map((p) => p.label)).toContain("May");
    expect(series.find((p) => p.label === "May")!.revenue).toBe(0);
  });

  it("counts a month with expenses but no revenue as a real, losing month", () => {
    /* Salaries paid and nothing invoiced IS a result — a bad one. Only a month with
       neither is excluded. */
    const s = monthlySeries({
      fyStartYear: 2026,
      revenue: [{ date: "2026-06-10", amount: 100_000 }],
      expenses: [{ date: "2026-05-28", amount: 80_000 }],
      cogsRatio: 0.5, today: "2026-08-18",
    });
    const { worst, lossMonths } = trendHighlights(s);
    expect(worst!.label).toBe("May");
    expect(lossMonths).toBe(1);
  });

  it("returns nulls when every finished month was empty", () => {
    const s = monthlySeries({
      fyStartYear: 2026, revenue: [], expenses: [], cogsRatio: 0.5, today: "2026-08-18",
    });
    expect(trendHighlights(s).best).toBeNull();
  });
});
