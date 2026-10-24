// R-1774 (Pardeep, 23 Oct 2026, staging: "All 89 · Annual 86 · Annual · in parts 1 · Monthly 1 ·
// Quarterly 1" — "cycle wali patti me kya sab logical hai, khaas kar quarterly").
// Google Workspace sells Annual or Flexible (monthly); Microsoft sells Monthly, Annual or 3-year.
// Nobody sells a 3- or 6-month TERM, so such a row is a data problem, not a cycle choice.
import { describe, it, expect } from "vitest";
import {
  subscriptionCycle,
  matchesCycle,
  cycleOptions,
  cycleInvoiceTitle,
  cycleFromUrl,
  CYCLE_FILTERS,
  CYCLE_URL_VALUES,
  CYCLE_LABEL,
  type CycleSub,
} from "./billing-cycle";

const sub = (over: Partial<CycleSub> = {}): CycleSub => ({
  billing_cycle: "yearly",
  term_months: 12,
  start_date: "2026-01-01",
  renewal_date: "2027-01-01",
  ...over,
});

/* The owner's staging row: "T-19-19Oct Cancel Refund", Google Workspace, ₹1,620 a quarter. */
const ownerQuarterly = sub({ billing_cycle: "quarterly", term_months: 3, start_date: "2026-07-19", renewal_date: "2026-10-19" });
const annual      = sub();
const splitQtr    = sub({ billing_cycle: "quarterly", term_months: 12 });
const splitMonth  = sub({ billing_cycle: "monthly", term_months: 12 });
const splitHalf   = sub({ billing_cycle: "half_yearly", term_months: 12 });
const flexMonthly = sub({ billing_cycle: "monthly", term_months: 1, renewal_date: null });
const qtrSpan     = sub({ billing_cycle: "yearly", renewal_date: "2026-04-01" });
const halfSpan    = sub({ billing_cycle: "yearly", renewal_date: "2026-07-01" });
const triennial   = sub({ billing_cycle: "yearly", term_months: 36, renewal_date: "2029-01-01" });
const triennialMo = sub({ billing_cycle: "monthly", term_months: 36 });
const noDates     = sub({ start_date: null, renewal_date: null });

describe("R-1774 — chip names say what they mean", () => {
  it("uses the vendor words", () => {
    expect(CYCLE_LABEL.annual).toBe("Annual · billed yearly");
    expect(CYCLE_LABEL.annual_split).toBe("Annual · billed monthly/quarterly");
    expect(CYCLE_LABEL.monthly).toBe("Monthly (Flexible)");
    expect(CYCLE_LABEL.three_year).toBe("3 years");
    expect(CYCLE_LABEL.check_term).toBe("Check term");
    expect(CYCLE_LABEL.none).toBe("No term");
  });

  it("no chip called Quarterly or Half-yearly any more", () => {
    expect(Object.values(CYCLE_LABEL).join("|")).not.toMatch(/Quarterly|Half-yearly/);
  });
});

describe("R-1774 — a 3- or 6-month TERM goes under Check term", () => {
  it("the owner's quarterly row (billed quarterly, term 3 months) is Check term", () => {
    expect(subscriptionCycle(ownerQuarterly).kind).toBe("check_term");
  });
  it("a quarter or half-year start↔renewal span is Check term too", () => {
    expect(subscriptionCycle(qtrSpan).kind).toBe("check_term");
    expect(subscriptionCycle(halfSpan).kind).toBe("check_term");
  });
  it("a 3-month term billed monthly is Check term, not Monthly (Flexible)", () => {
    expect(subscriptionCycle(sub({ billing_cycle: "monthly", term_months: 3 })).kind).toBe("check_term");
  });
  it("the row says what to do, and never changes the data", () => {
    const before = JSON.stringify(ownerQuarterly);
    const c = subscriptionCycle(ownerQuarterly);
    expect(c.label).toBe("Check term — vendors sell annual or monthly");
    expect(JSON.stringify(ownerQuarterly)).toBe(before);
  });
  it("the chip is yellow and its tooltip points at Correct details", () => {
    const opt = cycleOptions([annual, ownerQuarterly], "all").find((o) => o.value === "check_term")!;
    expect(opt.tone).toBe("warning");
    expect(opt.count).toBe(1);
    expect(opt.hint).toMatch(/Correct details/);
  });
});

describe("R-1774 — 3 years", () => {
  it("term_months 36 is its own kind, whatever the billing", () => {
    expect(subscriptionCycle(triennial).kind).toBe("three_year");
    expect(subscriptionCycle(triennialMo).kind).toBe("three_year");
  });
  it("row label names the term and how it is billed", () => {
    expect(subscriptionCycle(triennial).label).toBe("3 years · billed yearly");
    expect(subscriptionCycle(triennialMo).label).toBe("3 years · billed monthly");
  });
});

describe("R-1774 — row labels use the chip words", () => {
  it("annual billed yearly", () => {
    expect(subscriptionCycle(annual).label).toBe("Annual · billed yearly");
  });
  it("annual billed in parts names the part", () => {
    expect(subscriptionCycle(splitQtr).label).toBe("Annual · billed quarterly");
    expect(subscriptionCycle(splitMonth).label).toBe("Annual · billed monthly");
    expect(subscriptionCycle(splitHalf).label).toBe("Annual · billed half-yearly");
  });
  it("monthly flexible", () => {
    expect(subscriptionCycle(flexMonthly).kind).toBe("monthly");
    expect(subscriptionCycle(flexMonthly).label).toBe("Monthly (Flexible)");
  });
  it("no term → no label", () => {
    expect(subscriptionCycle(noDates).kind).toBe("none");
    expect(subscriptionCycle(noDates).label).toBeNull();
  });
  it("tooltip keeps the per-invoice amount", () => {
    expect(cycleInvoiceTitle(subscriptionCycle(splitQtr), "₹7,646")).toBe(
      "Annual · billed quarterly — ₹7,646 per invoice",
    );
    expect(cycleInvoiceTitle(subscriptionCycle(ownerQuarterly), "₹1,620")).toMatch(
      /^Saved as a 3-month term — ₹1,620 per invoice\. .*Correct details/,
    );
  });
});

describe("R-1774 — Annual · billed monthly/quarterly tooltip counts the parts", () => {
  it("says how many are monthly, quarterly and half-yearly", () => {
    const opt = cycleOptions([splitMonth, splitMonth, splitQtr, splitHalf, annual], "all")
      .find((o) => o.value === "annual_split")!;
    expect(opt.count).toBe(4);
    expect(opt.hint).toBe("Annual term, billed in parts: 2 monthly, 1 quarterly, 1 half-yearly");
  });
  it("leaves out a part with none", () => {
    const opt = cycleOptions([splitQtr], "all").find((o) => o.value === "annual_split")!;
    expect(opt.hint).toBe("Annual term, billed in parts: 1 quarterly");
  });
});

describe("R-1774 — counts still add up, chips only where count > 0", () => {
  const rows = [annual, splitQtr, splitMonth, flexMonthly, ownerQuarterly, qtrSpan, halfSpan, triennial, noDates];
  it("sum of chips = All", () => {
    const opts = cycleOptions(rows, "all");
    const sum = opts.filter((o) => o.value !== "all").reduce((a, o) => a + o.count, 0);
    expect(sum).toBe(rows.length);
    expect(opts.every((o) => o.value === "all" || o.count > 0)).toBe(true);
  });
  it("order: All, annual, in parts, 3 years, monthly, check term, no term", () => {
    expect(cycleOptions(rows, "all").map((o) => o.value)).toEqual([
      "all", "annual", "annual_split", "three_year", "monthly", "check_term", "none",
    ]);
  });
});

describe("R-1774 — old ?cycle= links still filter", () => {
  it("quarterly and half_yearly are still accepted in the URL", () => {
    expect(CYCLE_URL_VALUES).toContain("quarterly");
    expect(CYCLE_URL_VALUES).toContain("half_yearly");
    for (const v of CYCLE_FILTERS) expect(CYCLE_URL_VALUES).toContain(v);
  });
  it("and open the Check term rows", () => {
    expect(cycleFromUrl("quarterly")).toBe("check_term");
    expect(cycleFromUrl("half_yearly")).toBe("check_term");
    expect(cycleFromUrl("annual_split")).toBe("annual_split");
    expect(matchesCycle(ownerQuarterly, cycleFromUrl("quarterly"))).toBe(true);
    expect(matchesCycle(annual, cycleFromUrl("quarterly"))).toBe(false);
  });
});
