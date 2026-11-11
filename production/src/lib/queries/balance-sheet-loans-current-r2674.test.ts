import { describe, it, expect } from "vitest";
import { loansCurrentUnlessMissing } from "./balance-sheet";

/**
 * R-2674: the current part of the loan lines comes from loans_current_split(). Only "the function
 * is not on this database yet" may read as "nothing is current" (the sheet as it was before);
 * every other failure must fail the query — never a silently wrong current ratio.
 */
describe("loansCurrentUnlessMissing", () => {
  it("returns the figures the RPC gave", async () => {
    await expect(loansCurrentUnlessMissing(async () => ({
      loans_given_current: 334_446, employee_loans_current: 720_000, loans_given_undecided: 1, loans_given_undecided_amount: 300_000,
    }))).resolves.toEqual({ loansGiven: 334_446, employeeLoans: 720_000, undecidedCount: 1, undecidedAmount: 300_000 });
  });

  it("is null (loans stay non-current) only when the function is not installed", async () => {
    await expect(loansCurrentUnlessMissing(async () => { throw { code: "PGRST202", message: "Could not find the function" }; })).resolves.toBeNull();
    await expect(loansCurrentUnlessMissing(async () => { throw { code: "42883", message: "function does not exist" }; })).resolves.toBeNull();
  });

  it("throws any other failure", async () => {
    const denied = { code: "42501", message: "permission denied" };
    await expect(loansCurrentUnlessMissing(async () => { throw denied; })).rejects.toBe(denied);
    await expect(loansCurrentUnlessMissing(async () => { throw new TypeError("Failed to fetch"); })).rejects.toThrow("Failed to fetch");
  });
});
