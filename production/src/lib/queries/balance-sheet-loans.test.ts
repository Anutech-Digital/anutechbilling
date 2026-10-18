import { describe, it, expect } from "vitest";
import { loansGivenUnlessMissing } from "./balance-sheet";

/**
 * R-1581: the Balance Sheet "Loans given" asset used `.catch(() => 0)` — ANY failure printed
 * ₹0 for money owed to the company, with no warning. Only "the RPC is not on this database
 * yet" may read as 0; every other error must fail the query so the page shows LoadError.
 */
describe("loansGivenUnlessMissing", () => {
  it("returns the RPC's figure", async () => {
    await expect(loansGivenUnlessMissing(async () => 125_000)).resolves.toBe(125_000);
  });

  it("is 0 only when the function is not installed (PGRST202 / 42883)", async () => {
    await expect(loansGivenUnlessMissing(async () => { throw { code: "PGRST202", message: "Could not find the function" }; })).resolves.toBe(0);
    await expect(loansGivenUnlessMissing(async () => { throw { code: "42883", message: "function does not exist" }; })).resolves.toBe(0);
  });

  it("throws any other failure instead of printing ₹0", async () => {
    const denied = { code: "42501", message: "permission denied" };
    await expect(loansGivenUnlessMissing(async () => { throw denied; })).rejects.toBe(denied);
    await expect(loansGivenUnlessMissing(async () => { throw new TypeError("Failed to fetch"); })).rejects.toThrow("Failed to fetch");
  });
});
