import { describe, it, expect } from "vitest";
import { matchTdsShortfall, tdsShortfallLine } from "./tds-match";

describe("matchTdsShortfall (R-1520)", () => {
  it("INV-A378: ₹3,00,900 total, ₹2,75,400 received, 18% GST → 194J 10% = ₹25,500 on ₹2,55,000", () => {
    const m = matchTdsShortfall({ totalInclGst: 300_900, received: 275_400, gstRatePct: 18 });
    expect(m).toEqual({ section: "194J", ratePct: 10, tds: 25_500, base: 255_000, shortfall: 25_500 });
  });

  it("2% case: ₹1,18,000 total, ₹1,16,000 received → 2% of ₹1,00,000 (194J technical first)", () => {
    const m = matchTdsShortfall({ totalInclGst: 118_000, received: 116_000, gstRatePct: 18 });
    expect(m).toMatchObject({ section: "194J", ratePct: 2, tds: 2_000, base: 100_000 });
  });

  it("2% with the customer's own section 194C preferred → 194C 2%", () => {
    const m = matchTdsShortfall({ totalInclGst: 118_000, received: 116_000, gstRatePct: 18, preferredSection: "194C" });
    expect(m).toMatchObject({ section: "194C", ratePct: 2, tds: 2_000 });
  });

  it("1% case → 194C 1%", () => {
    const m = matchTdsShortfall({ totalInclGst: 118_000, received: 117_000, gstRatePct: 18 });
    expect(m).toMatchObject({ section: "194C", ratePct: 1, tds: 1_000 });
  });

  it("±₹1 rounding still matches; ₹2 off does not", () => {
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 275_401, gstRatePct: 18 })?.ratePct).toBe(10);
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 275_399, gstRatePct: 18 })?.ratePct).toBe(10);
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 275_402, gstRatePct: 18 })).toBeNull();
  });

  it("random shortfall → null", () => {
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 280_000, gstRatePct: 18 })).toBeNull();
  });

  it("nothing short, overpaid, or nothing received → null", () => {
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 300_900, gstRatePct: 18 })).toBeNull();
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 310_000, gstRatePct: 18 })).toBeNull();
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 0, gstRatePct: 18 })).toBeNull();
  });

  it("GST at the invoice's own rate (5%), and null rate falls back to 18% like tdsBase", () => {
    // ₹1,05,000 at 5% → base ₹1,00,000 → 10% = ₹10,000
    expect(matchTdsShortfall({ totalInclGst: 105_000, received: 95_000, gstRatePct: 5 })).toMatchObject({ ratePct: 10, tds: 10_000 });
    expect(matchTdsShortfall({ totalInclGst: 300_900, received: 275_400, gstRatePct: null })).toMatchObject({ ratePct: 10 });
  });

  it("the line says the amount, section and rate", () => {
    const m = matchTdsShortfall({ totalInclGst: 300_900, received: 275_400, gstRatePct: 18 })!;
    expect(tdsShortfallLine(m)).toBe("The remaining ₹25,500 may be TDS (194J 10%)");
  });
});
