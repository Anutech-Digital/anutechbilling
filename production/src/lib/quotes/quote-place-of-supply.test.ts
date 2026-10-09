import { describe, it, expect } from "vitest";
import { quotePlaceOfSupply, gstHeadLabel } from "./quote-place-of-supply";

/* R-376 (f): the quote's place of supply names the buyer's STATE and code (Rule 46(n)),
   and a quote raised on a lead takes the lead's state — it used to print "Intra-state"
   for a Haryana lead quoted by a Delhi seller. */
const DELHI_SELLER = { state_code: "07", gstin: "07ABDCA0298H1ZP" };
const HARYANA_GSTIN = "06AABCF1234A1ZI";
const MAHA_GSTIN = "27AABCE1234D1Z9";

describe("quotePlaceOfSupply", () => {
  it("inter-state customer → state name + code + IGST", () => {
    const p = quotePlaceOfSupply({ customer: { state_code: "06" }, seller: DELHI_SELLER });
    expect(p).toMatchObject({ posCode: "06", interState: true, isExport: false });
    expect(p.label).toBe("Haryana (06) · IGST");
  });

  it("same-state buyer → CGST + SGST with the state named", () => {
    expect(quotePlaceOfSupply({ customer: { state_code: "07" }, seller: DELHI_SELLER }).label)
      .toBe("Delhi (07) · CGST + SGST");
  });

  it("a lead quote (no customer) uses the lead's state", () => {
    const p = quotePlaceOfSupply({ customer: null, lead: { state_code: "06" }, seller: DELHI_SELLER });
    expect(p.interState).toBe(true);
    expect(p.label).toBe("Haryana (06) · IGST");
  });

  it("a lead with only a GSTIN gets the state its GSTIN proves", () => {
    expect(quotePlaceOfSupply({ lead: { state_code: null, gstin: HARYANA_GSTIN }, seller: DELHI_SELLER }).label)
      .toBe("Haryana (06) · IGST");
  });

  it("customer wins over lead and the quote's typed prospect state", () => {
    const p = quotePlaceOfSupply({
      customer: { gstin: MAHA_GSTIN }, lead: { state_code: "06" },
      quote: { prospect_state_code: "29" }, seller: DELHI_SELLER,
    });
    expect(p.label).toBe("Maharashtra (27) · IGST");
  });

  it("typed prospect (no customer, no lead) uses prospect_state_code", () => {
    expect(quotePlaceOfSupply({ quote: { prospect_state_code: "29" }, seller: DELHI_SELLER }).label)
      .toBe("Karnataka (29) · IGST");
  });

  it("an unpadded hand-typed code still names the state", () => {
    expect(quotePlaceOfSupply({ customer: { state_code: "6" }, seller: DELHI_SELLER }).label)
      .toBe("Haryana (06) · IGST");
  });

  it("nothing known → the old honest wording, intra-state default", () => {
    const p = quotePlaceOfSupply({ seller: DELHI_SELLER });
    expect(p.posCode).toBeNull();
    expect(p.label).toBe("Intra-state (CGST + SGST)");
  });

  it("foreign buyer → export, no state", () => {
    const p = quotePlaceOfSupply({ customer: { state_code: "06", country: "USA" }, seller: DELHI_SELLER });
    expect(p).toMatchObject({ isExport: true, interState: false, posCode: null });
    expect(p.label).toBe("Export · USA (96)");
  });
});

describe("R-389 (F9): gstHeadLabel", () => {
  it("inter-state is IGST, not 'GST'", () => {
    expect(gstHeadLabel({ ratePct: 18, interState: true })).toBe("IGST 18%");
  });
  it("intra-state splits CGST + SGST", () => {
    expect(gstHeadLabel({ ratePct: 18, interState: false })).toBe("CGST 9% + SGST 9%");
  });
  it("export is zero-rated", () => {
    expect(gstHeadLabel({ ratePct: 0, interState: false, isExport: true })).toBe("GST 0% (export)");
    expect(gstHeadLabel({ ratePct: 0, interState: false })).toBe("GST 0%");
  });
  it("matches quotePlaceOfSupply for a Haryana buyer of a Delhi seller", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "06" }, seller: { state_code: "07" } });
    expect(gstHeadLabel({ ratePct: 18, interState: pos.interState, isExport: pos.isExport })).toBe("IGST 18%");
  });
});

describe("R-431 (board R-406): company state empty", () => {
  it("does not print the intra-state guess when the seller has no state", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "06" }, seller: { state_code: null } });
    expect(pos.head.kind).toBe("seller_state_missing");
    expect(pos.label).toBe("Haryana (06) · GST head pending (company state not set)");
    expect(pos.label).not.toMatch(/CGST/);
  });

  it("the company GSTIN alone does not clear it — generate_invoice reads tenants.state_code only", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: "06" }, seller: { state_code: null, gstin: "07AAACR5055K1Z5" } });
    expect(pos.head.kind).toBe("seller_state_missing");
  });

  it("customer with no state → buyer_state_missing", () => {
    const pos = quotePlaceOfSupply({ customer: { state_code: null }, seller: { state_code: "07" } });
    expect(pos.head.kind).toBe("buyer_state_missing");
  });

  it("same state → intra_state; different state → inter_state", () => {
    expect(quotePlaceOfSupply({ customer: { state_code: "07" }, seller: { state_code: "07" } }).head.kind).toBe("intra_state");
    const inter = quotePlaceOfSupply({ customer: { state_code: "06" }, seller: { state_code: "07" } });
    expect(inter.head.kind).toBe("inter_state");
    expect(inter.label).toBe("Haryana (06) · IGST");
  });
});
