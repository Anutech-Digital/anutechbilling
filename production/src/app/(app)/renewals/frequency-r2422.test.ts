/* R-2422 — Pardeep, 3 Nov (staging Renewals screenshot): the row said "₹78,000/yr" but not how it
   is paid. Owner's words (3 Nov, second ask): the COMMITMENT and the payment frequency —
   "Annual commitment · paid yearly" / "Annual commitment · paid quarterly · ₹X each" /
   "Monthly commitment (flex)" — built on the Subscriptions list's rule (subscriptionCycle). */
import { describe, expect, it } from "vitest";
import { renewalFrequency, renewalCommitment } from "./frequency";

const BASE = { mrr: 6500, term_amount: 78000, start_date: "2025-11-10", renewal_date: "2026-11-10" };

describe("R-2422 renewalFrequency — commitment + how it is paid", () => {
  it("annual paid once a year → 'Annual commitment · paid yearly' (no per-part amount)", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "yearly", term_months: 12 })).toBe("Annual commitment · paid yearly");
  });

  it("annual billed in quarters → 'Annual commitment · paid quarterly · ₹19,500 each' (one part, from term_amount)", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "quarterly", term_months: 12 })).toBe("Annual commitment · paid quarterly · ₹19,500 each");
  });

  it("annual billed half-yearly / monthly → the part's amount", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "half_yearly", term_months: 12 })).toBe("Annual commitment · paid half-yearly · ₹39,000 each");
    expect(renewalFrequency({ ...BASE, billing_cycle: "monthly", term_months: 12 })).toBe("Annual commitment · paid monthly · ₹6,500 each");
  });

  it("no exact term amount → the part is rebuilt from the monthly and says 'about'", () => {
    expect(renewalFrequency({ ...BASE, term_amount: null, mrr: 1667, billing_cycle: "quarterly", term_months: 12 }))
      .toBe("Annual commitment · paid quarterly · about ₹5,001 each");
  });

  it("month-to-month plan → 'Monthly commitment (flex)'", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "monthly", term_months: 1, term_amount: 6500, renewal_date: "2025-12-10" })).toBe("Monthly commitment (flex)");
  });

  it("3-year term → '3-year commitment · paid yearly'", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "yearly", term_months: 36 })).toBe("3-year commitment · paid yearly");
  });

  it("no dates to tell the term → nothing (no made-up words)", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "yearly", term_months: 12, start_date: null })).toBeNull();
  });
});

describe("R-2422 renewalCommitment — the Commitment filter's value", () => {
  it("annual (any payment frequency, 3-year too) vs monthly flex", () => {
    expect(renewalCommitment({ ...BASE, billing_cycle: "yearly", term_months: 12 })).toBe("annual");
    expect(renewalCommitment({ ...BASE, billing_cycle: "quarterly", term_months: 12 })).toBe("annual");
    expect(renewalCommitment({ ...BASE, billing_cycle: "yearly", term_months: 36 })).toBe("annual");
    expect(renewalCommitment({ ...BASE, billing_cycle: "monthly", term_months: 1, renewal_date: "2025-12-10" })).toBe("monthly");
  });

  it("no dates: term_months decides (missing = 12, as the billing schedule reads it); never unknown", () => {
    expect(renewalCommitment({ ...BASE, billing_cycle: "yearly", term_months: 1, start_date: null })).toBe("monthly");
    expect(renewalCommitment({ ...BASE, billing_cycle: "yearly", term_months: null, start_date: null })).toBe("annual");
    /* A 'Check term' (3-month) row stays reachable under Annual. */
    expect(renewalCommitment({ ...BASE, billing_cycle: "quarterly", term_months: 3 })).toBe("annual");
  });

  it("a 1-month term renewed by quote (not billed in parts) is Monthly, but not called flex", () => {
    const quoted = { ...BASE, billing_cycle: "yearly", term_months: 1, renewal_date: "2025-12-10" };
    expect(renewalCommitment(quoted)).toBe("monthly");
    expect(renewalFrequency(quoted)).toBe("Monthly commitment");
  });
});
