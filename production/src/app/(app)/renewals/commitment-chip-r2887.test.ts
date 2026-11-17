/* R-2887 — Pardeep, 17 Nov: "renewal monthly hai ya yearly ye bhi renewal list me show hona chahiye".
   The row chip comes from the same rule as the "All commitments" filter (frequency.ts). */
import { describe, expect, it } from "vitest";
import { commitmentChip, renewalCommitment } from "./frequency";

const BASE = { mrr: 6500, term_amount: 78000, start_date: "2025-11-10", renewal_date: "2026-11-10" };
const subs = [
  { name: "yearly", sub: { ...BASE, billing_cycle: "yearly", term_months: 12 }, text: "Annual · paid yearly", title: "Annual commitment, billed once a year" },
  { name: "annual paid monthly", sub: { ...BASE, billing_cycle: "monthly", term_months: 12 }, text: "Annual · paid monthly", title: "Annual commitment, billed every month" },
  { name: "annual paid quarterly", sub: { ...BASE, billing_cycle: "quarterly", term_months: 12 }, text: "Annual · paid quarterly", title: "Annual commitment, billed every quarter" },
  { name: "3 years", sub: { ...BASE, billing_cycle: "yearly", term_months: 36, start_date: "2024-11-10", renewal_date: "2027-11-10" }, text: "3 years · paid yearly", title: "3-year commitment, billed once a year" },
  { name: "flexible monthly", sub: { ...BASE, billing_cycle: "monthly", term_months: 1, renewal_date: "2025-12-10" }, text: "Flexible (monthly)", title: "Monthly commitment — renews month to month, billed every month" },
];

describe("R-2887 commitmentChip", () => {
  for (const c of subs) {
    it(`${c.name} → "${c.text}"`, () => {
      expect(commitmentChip(c.sub)).toEqual({ text: c.text, title: c.title });
    });
  }

  it("agrees with the All commitments filter: monthly chip ⇔ filter 'monthly'", () => {
    for (const c of subs) {
      const monthly = commitmentChip(c.sub)!.text === "Flexible (monthly)";
      expect(renewalCommitment(c.sub) === "monthly", c.name).toBe(monthly);
    }
  });

  it("unknown term → no chip, never a wrong one", () => {
    expect(commitmentChip({ ...BASE, billing_cycle: "yearly", term_months: 12, start_date: null })).toBeNull();
    expect(commitmentChip({ ...BASE, billing_cycle: "yearly", term_months: null, start_date: null, renewal_date: null })).toBeNull();
    /* 'Check term' (a 3-month term) is a data problem — no chip */
    expect(commitmentChip({ ...BASE, billing_cycle: "quarterly", term_months: 3 })).toBeNull();
  });
});
