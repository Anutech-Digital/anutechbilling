/**
 * R-2193 (G-ZOHO) — one sale with Monthly flex seats AND a one-time line (domain / setup).
 *
 * A flex quote is never split into parts (its stored figures are one month — R-1974), and the
 * term is read off the quote's lines. A one-time line has no commitment, so when it came first the
 * quote was read as an annual commitment billed monthly: 12 parts of (seats + domain) ÷ 12.
 * The server now stores recurring lines first (migration 20261107233022), and firstLineCommitment
 * skips one-time lines so an older ordering reads the same.
 */
import { describe, it, expect } from "vitest";
import { firstLineCommitment, planForQuote } from "./instalments";

const FLEX_PLUS_DOMAIN = {
  subtotal: 3840, discount_pct: 0, tax_rate: 18, amount: 4531, billing_cycle: "monthly",
};

describe("R-2193: Monthly flex + one-time on one quote", () => {
  it("the term is the flex line's, whichever line comes first", () => {
    expect(firstLineCommitment([{ name: "Domain", one_time: true }, { name: "Seats", commitment: "monthly" }])).toBe("monthly");
    expect(firstLineCommitment([{ name: "Setup", commitment: "one_time" }, { name: "Seats", commitment: "annual_yearly" }])).toBe("annual_yearly");
    expect(firstLineCommitment([{ name: "Seats", commitment: "monthly" }, { name: "Domain", one_time: true }])).toBe("monthly");
  });

  it("a one-time-only quote keeps the old answer (first line's commitment, none here)", () => {
    expect(firstLineCommitment([{ name: "Setup", one_time: true }])).toBeNull();
    expect(firstLineCommitment([])).toBeNull();
  });

  it("is not split into 12 monthly parts when the domain line comes first", () => {
    const q = { ...FLEX_PLUS_DOMAIN, line_items: [
      { name: "Domain flex2193.in", qty: 1, rate: 1200, one_time: true },
      { name: "Google Workspace Business Starter", qty: 10, rate: 264, commitment: "monthly" },
    ] };
    expect(planForQuote(q, "2026-10-01")).toBeNull();
  });
});
