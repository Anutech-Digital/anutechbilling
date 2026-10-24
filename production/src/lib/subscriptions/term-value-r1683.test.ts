/**
 * R-1683 (staging T-12): the subscriptions list row said "Annual · ₹1,29,600" — the ORIGINAL
 * quote's 10-seat line — after 5 seats were added and MRR became ₹16,200 (₹1,94,400 a year).
 * The quote's contracted annual is only the truth while it still agrees with the stored MRR.
 */
import { describe, it, expect } from "vitest";
import { termValue } from "./renewal-display";

describe("termValue — the contracted annual only while it matches the MRR", () => {
  it("T-12: 15 seats now (mrr ₹16,200), quote line still 10 seats (₹1,29,600) → ₹1,94,400 from MRR", () => {
    expect(termValue(16_200, 12, 129_600)).toEqual({ amount: 194_400, exact: false });
  });

  it("the ₹2,000/yr support plan (mrr 167) keeps its exact contracted ₹2,000 — the R-876 rounding case", () => {
    expect(termValue(167, 12, 2_000)).toEqual({ amount: 2_000, exact: true });
  });

  it("no MRR stored → the contracted figure is all there is", () => {
    expect(termValue(0, 12, 2_000)).toEqual({ amount: 2_000, exact: true });
    expect(termValue(null, 12, 2_000)).toEqual({ amount: 2_000, exact: true });
  });
});
