// R-1696 — the Subscriptions list filters by billing cycle. The filter and the row's
// "Annual · ₹1,39,500" label come from ONE function (subscriptionCycle), so a row can
// never sit under "Monthly" while its own label says "Annual".
import { describe, it, expect } from "vitest";
import {
  subscriptionCycle,
  matchesCycle,
  cycleOptions,
  cycleInvoiceTitle,
  CYCLE_FILTERS,
  type CycleSub,
} from "./billing-cycle";
import { rowTerm } from "./renewal-display";

const sub = (over: Partial<CycleSub> = {}): CycleSub => ({
  billing_cycle: "yearly",
  term_months: 12,
  start_date: "2026-01-01",
  renewal_date: "2027-01-01",
  ...over,
});

const annual      = sub();
const splitQtr    = sub({ billing_cycle: "quarterly", term_months: 12 });
const splitMonth  = sub({ billing_cycle: "monthly", term_months: 12 });
const splitHalf   = sub({ billing_cycle: "half_yearly", term_months: 12 });
const flexMonthly = sub({ billing_cycle: "monthly", term_months: 1, renewal_date: null });
const qtrTerm     = sub({ billing_cycle: "yearly", renewal_date: "2026-04-01" });
const halfTerm    = sub({ billing_cycle: "yearly", renewal_date: "2026-07-01" });
const noDates     = sub({ start_date: null, renewal_date: null });

describe("subscriptionCycle — one rule for the label and the filter", () => {
  it("annual billed once a year", () => {
    expect(subscriptionCycle(annual).kind).toBe("annual");
    expect(subscriptionCycle(annual).term?.label).toBe("Annual");
  });

  it("an annual term billed in parts is its own kind, whatever the instalment", () => {
    expect(subscriptionCycle(splitQtr).kind).toBe("annual_split");
    expect(subscriptionCycle(splitMonth).kind).toBe("annual_split");
    expect(subscriptionCycle(splitHalf).kind).toBe("annual_split");
    // the row still names the instalment (R-876) — the label and filter come from the same call
    expect(subscriptionCycle(splitQtr).term?.label).toBe("Quarterly");
  });

  it("a split cycle with no term_months is read as the 12-month default", () => {
    expect(subscriptionCycle(sub({ billing_cycle: "quarterly", term_months: null })).kind).toBe("annual_split");
  });

  it("a monthly plan with a one-month term is Monthly, not an annual in parts", () => {
    expect(subscriptionCycle(flexMonthly).kind).toBe("monthly");
    expect(subscriptionCycle(flexMonthly).term?.label).toBe("Monthly");
  });

  it("quarterly and half-yearly terms from the start↔renewal span", () => {
    expect(subscriptionCycle(qtrTerm).kind).toBe("quarterly");
    expect(subscriptionCycle(halfTerm).kind).toBe("half_yearly");
  });

  it("no dates and no split cycle → no term", () => {
    expect(subscriptionCycle(noDates).kind).toBe("none");
    expect(subscriptionCycle(noDates).term).toBeNull();
  });

  it("the term is exactly what rowTerm gives — the row label cannot drift from the filter", () => {
    for (const s of [annual, splitQtr, splitMonth, splitHalf, flexMonthly, qtrTerm, halfTerm, noDates]) {
      expect(subscriptionCycle(s).term).toEqual(rowTerm(s.billing_cycle, s.start_date, s.renewal_date));
    }
  });
});

describe("cycleInvoiceTitle — the row tooltip", () => {
  it("keeps the old wording for a plain term", () => {
    expect(cycleInvoiceTitle(subscriptionCycle(annual), "₹1,39,500")).toBe("Annual — ₹1,39,500 per invoice");
  });
  it("says an annual term is billed in parts", () => {
    expect(cycleInvoiceTitle(subscriptionCycle(splitQtr), "₹7,646")).toBe(
      "Quarterly — ₹7,646 per invoice (annual term, billed in parts)",
    );
  });
});

describe("matchesCycle", () => {
  const all = [annual, splitQtr, splitMonth, flexMonthly, qtrTerm, halfTerm, noDates];
  it("'all' keeps every row", () => {
    expect(all.filter((s) => matchesCycle(s, "all"))).toHaveLength(all.length);
  });
  it("each kind keeps only its rows", () => {
    expect(all.filter((s) => matchesCycle(s, "monthly"))).toEqual([flexMonthly]);
    expect(all.filter((s) => matchesCycle(s, "annual_split"))).toEqual([splitQtr, splitMonth]);
    expect(all.filter((s) => matchesCycle(s, "annual"))).toEqual([annual]);
    expect(all.filter((s) => matchesCycle(s, "quarterly"))).toEqual([qtrTerm]);
  });
});

describe("cycleOptions — only the cycles in the data, each with a count", () => {
  it("lists All first, then only present kinds in a fixed order, with counts", () => {
    const opts = cycleOptions([annual, annual, flexMonthly, splitQtr], "all");
    expect(opts.map((o) => [o.value, o.count])).toEqual([
      ["all", 4],
      ["annual", 2],
      ["annual_split", 1],
      ["monthly", 1],
    ]);
  });
  it("the counts add up to All", () => {
    const rows = [annual, splitQtr, splitMonth, flexMonthly, qtrTerm, halfTerm, noDates];
    const opts = cycleOptions(rows, "all");
    const sum = opts.filter((o) => o.value !== "all").reduce((a, o) => a + o.count, 0);
    expect(sum).toBe(opts[0].count);
  });
  it("keeps the selected cycle on screen even when nothing matches it now", () => {
    const opts = cycleOptions([annual], "quarterly");
    expect(opts.find((o) => o.value === "quarterly")?.count).toBe(0);
  });
  it("every option value is a valid ?cycle= value", () => {
    for (const o of cycleOptions([annual, splitQtr, flexMonthly, qtrTerm, halfTerm, noDates], "all")) {
      expect(CYCLE_FILTERS).toContain(o.value);
    }
  });
});
