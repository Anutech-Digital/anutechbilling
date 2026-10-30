/* R-2095 (staging, 30 Oct): the Add seats preview said "CGST 9% + SGST 9%" for a Maharashtra customer
   of a Delhi company, while the invoice charged IGST — the head was printed before it was known. */
import { describe, expect, it } from "vitest";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";
import { seatTaxLabel } from "./add-seats-dialog";

const seller = { state_code: "07", gstin: "07ABDCA0000A1Z5" };

describe("R-2095 Add seats GST head", () => {
  it("Maharashtra customer of a Delhi company → IGST", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "27" }, seller });
    expect(seatTaxLabel({ loaded: true, pos, ratePct: 18 })).toBe("IGST 18%");
  });
  it("customer still loading → no CGST + SGST guess", () => {
    const pos = quotePlaceOfSupply({ customer: null, seller });
    expect(seatTaxLabel({ loaded: false, pos, ratePct: 18 })).toBe("GST 18%");
  });
  it("customer state unknown → GST 18%, not CGST + SGST", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: null, gstin: null }, seller });
    expect(seatTaxLabel({ loaded: true, pos, ratePct: 18 })).toBe("GST 18%");
  });
  it("same state, known → CGST + SGST", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "07" }, seller });
    expect(seatTaxLabel({ loaded: true, pos, ratePct: 18 })).toMatch(/CGST 9% \+ SGST 9%/);
  });
});
