/**
 * R-2095 (30 Oct 2026, September reconcile): a half-yearly sale from 19 Jun was filed with
 * "Renews on" 19 Dec 2026 — the next half's date. The schedule counts the year back from the
 * renewal date, so the next half's request covered the paid half again. The reconcile form now
 * refuses a renewal date inside the first year for a 1-year commitment billed in parts.
 */
import { describe, it, expect } from "vitest";
import { splitRenewalProblem, defaultRenewal } from "./credit-pay-for";

describe("R-2095 renewal date of a sale billed in parts", () => {
  it("half-yearly, renews on the next half's date → refused, says the year end", () => {
    const m = splitRenewalProblem("2026-06-19", "2026-12-19", "half_yearly", false);
    expect(m).toMatch(/half-yearly on a 1-year commitment/);
    expect(m).toContain("19 Jun 2027");
  });
  it("quarterly, renews on the next quarter → refused", () => {
    expect(splitRenewalProblem("2026-06-19", "2026-09-19", "quarterly", false)).not.toBeNull();
  });
  it("the default (start + 1 year) and the day before are fine", () => {
    expect(splitRenewalProblem("2026-06-19", defaultRenewal("2026-06-19", false), "half_yearly", false)).toBeNull();
    expect(splitRenewalProblem("2026-06-19", "2027-06-18", "quarterly", false)).toBeNull();
  });
  it("yearly billing and Monthly flex are not checked", () => {
    expect(splitRenewalProblem("2026-06-19", "2026-12-19", "yearly", false)).toBeNull();
    expect(splitRenewalProblem("2026-06-19", "2026-07-19", "monthly", true)).toBeNull();
  });
});
