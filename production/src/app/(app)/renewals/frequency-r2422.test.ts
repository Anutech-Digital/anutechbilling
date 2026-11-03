/* R-2422 — Pardeep, 3 Nov (staging Renewals screenshot): the row said "₹78,000/yr" but not how it
   is paid. The amount cell now says it in the Subscriptions list's own words (subscriptionCycle). */
import { describe, expect, it } from "vitest";
import { subscriptionCycle } from "@/lib/subscriptions/billing-cycle";
import { renewalFrequency } from "./frequency";

const BASE = { mrr: 6500, term_amount: 78000, start_date: "2025-11-10", renewal_date: "2026-11-10" };

describe("R-2422 renewalFrequency — the Subscriptions list's words on the Renewals row", () => {
  it("annual paid once a year → 'Annual · paid yearly' (no per-part amount)", () => {
    const sub = { ...BASE, billing_cycle: "yearly", term_months: 12 };
    expect(renewalFrequency(sub)).toBe("Annual · paid yearly");
    expect(renewalFrequency(sub)).toBe(subscriptionCycle(sub).label);
  });

  it("annual billed in quarters → 'Annual · paid quarterly · ₹19,500 each' (one part, from term_amount)", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "quarterly", term_months: 12 })).toBe("Annual · paid quarterly · ₹19,500 each");
  });

  it("annual billed half-yearly / monthly → the part's amount", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "half_yearly", term_months: 12 })).toBe("Annual · paid half-yearly · ₹39,000 each");
    expect(renewalFrequency({ ...BASE, billing_cycle: "monthly", term_months: 12 })).toBe("Annual · paid monthly · ₹6,500 each");
  });

  it("no exact term amount → the part is rebuilt from the monthly and says 'about'", () => {
    expect(renewalFrequency({ ...BASE, term_amount: null, mrr: 1667, billing_cycle: "quarterly", term_months: 12 }))
      .toBe("Annual · paid quarterly · about ₹5,001 each");
  });

  it("month-to-month plan → 'Flexible (monthly)'", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "monthly", term_months: 1, term_amount: 6500, renewal_date: "2025-12-10" })).toBe("Flexible (monthly)");
  });

  it("no dates to tell the term → nothing (no made-up words)", () => {
    expect(renewalFrequency({ ...BASE, billing_cycle: "yearly", term_months: 12, start_date: null })).toBeNull();
  });
});
