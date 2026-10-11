import { describe, it, expect } from "vitest";
import { term, rowTerm, renewalDistance, termValue } from "./renewal-display";

describe("term — the label AND the money it implies", () => {
  it("reads a 12-month span as Annual", () => {
    // The real shape of all 54 production subscriptions.
    expect(term("2026-07-23", "2027-07-23")).toEqual({ label: "Annual", months: 12 });
  });

  it("prices an annual renewal at 12× MRR", () => {
    const t = term("2026-07-23", "2027-07-23")!;
    expect(1350 * t.months).toBe(16_200);   // what the card shows
  });

  it("reads a one-month span as Monthly, and does not multiply", () => {
    expect(term("2026-08-01", "2026-09-01")).toEqual({ label: "Monthly", months: 1 });
  });

  it("reads a quarter as Quarterly at 3×, not annual at 12×", () => {
    // The bug this test exists for: a quarterly sub billed at ₹1,350/mo shows
    // ₹4,050 per renewal. Calling it Annual would show ₹16,200 — a 4× overstatement
    // of what the customer is about to be invoiced.
    const t = term("2026-08-01", "2026-11-01")!;
    expect(t).toEqual({ label: "Quarterly", months: 3 });
    expect(1350 * t.months).toBe(4_050);
  });

  it("reads six months as Half-yearly at 6×", () => {
    const t = term("2026-08-01", "2027-02-01")!;
    expect(t).toEqual({ label: "Half-yearly", months: 6 });
  });

  it("keeps label and months in agreement for every bucket", () => {
    // The operator reads "Quarterly · ₹4,050". If the label said Quarterly while
    // months was 4, the total would silently contradict the label.
    const expected: Record<string, number> = { Monthly: 1, Quarterly: 3, "Half-yearly": 6, Annual: 12 };
    for (const [start, renewal] of [
      ["2026-01-01", "2026-02-01"],
      ["2026-01-01", "2026-04-01"],
      ["2026-01-01", "2026-07-01"],
      ["2026-01-01", "2027-01-01"],
      ["2026-01-01", "2029-01-01"],
    ] as const) {
      const t = term(start, renewal)!;
      expect(t.months).toBe(expected[t.label]);
    }
  });

  it("returns null rather than guessing when a date is missing", () => {
    expect(term(null, "2027-07-23")).toBeNull();
    expect(term("2026-07-23", null)).toBeNull();
    expect(term(null, null)).toBeNull();
    expect(term(undefined, undefined)).toBeNull();
  });

  it("returns null on a renewal date that precedes the start date", () => {
    // Corrupt data, not a term. A negative span must never become "Monthly".
    expect(term("2027-07-23", "2026-07-23")).toBeNull();
    expect(term("2026-07-23", "2026-07-23")).toBeNull();
  });

  it("treats a multi-year term as Annual — never more than 12× MRR", () => {
    // A 3-year deal must not render as "₹4,86,000 at each renewal".
    const t = term("2026-01-01", "2029-01-01")!;
    expect(t.months).toBe(12);
  });
});

describe("renewalDistance — the number the whole cadence turns on", () => {
  it("gives exact days while the renewal is close enough to act on", () => {
    expect(renewalDistance(3)).toBe("in 3 days");
    expect(renewalDistance(30)).toBe("in 30 days");
    expect(renewalDistance(60)).toBe("in 60 days");
  });

  it("switches to months past 60 days, where exact days mean nothing", () => {
    expect(renewalDistance(61)).toBe("in ~2 months");
    // The real production case: 23 Jul 2027 seen from 13 Aug 2026.
    expect(renewalDistance(344)).toBe("in ~11 months");
  });

  it("handles today and tomorrow without awkward grammar", () => {
    expect(renewalDistance(0)).toBe("due today");
    expect(renewalDistance(1)).toBe("in 1 day");
    expect(renewalDistance(2)).toBe("in 2 days");
  });

  it("states overdue as overdue — never as a negative day count", () => {
    // "in -14 days" is the kind of thing that makes an operator distrust a page.
    expect(renewalDistance(-14)).toBe("14d overdue");
    expect(renewalDistance(-1)).toBe("1d overdue");
    expect(renewalDistance(-400)).not.toContain("-");
  });

  it("degrades to a dash rather than printing NaN", () => {
    expect(renewalDistance(NaN)).toBe("—");
    expect(renewalDistance(Infinity)).toBe("—");
  });
});

/* R-876: a saved quarterly subscription spans 12 months, and the list row read
   "Annual · about ₹18,000". The billing cycle now names the row. */
describe("rowTerm — R-876", () => {
  const S = "2026-10-01", R = "2027-09-30";
  it("billing_cycle quarterly says Quarterly, and its amount is one quarter", () => {
    const t = rowTerm("quarterly", S, R)!;
    expect(t.label).toBe("Quarterly");
    expect(termValue(1500, t.months, 18_000).amount).toBe(4_500);
  });
  it("billing_cycle monthly says Monthly", () => {
    expect(rowTerm("monthly", S, R)!.label).toBe("Monthly");
  });
  it("billing_cycle yearly says Annual", () => {
    expect(rowTerm("yearly", S, R)!.label).toBe("Annual");
  });
  it("yearly (the column default) still defers to the span for old rows", () => {
    expect(rowTerm("yearly", "2026-10-01", "2026-10-31")!.label).toBe("Monthly");
  });
});
