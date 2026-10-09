import { describe, it, expect } from "vitest";
import { isInterStateSupply, isExportSupply, gstTreatment, placeOfSupplyLabel, frozenParty, supplyHead } from "./place-of-supply";

describe("isInterStateSupply", () => {
  it("intra-state: same state code → false (CGST + SGST)", () => {
    expect(isInterStateSupply("07", "07")).toBe(false); // Delhi → Delhi
    expect(isInterStateSupply("27", "27")).toBe(false); // Maharashtra → Maharashtra
  });

  it("inter-state: different state codes → true (IGST)", () => {
    expect(isInterStateSupply("27", "07")).toBe(true); // Maharashtra buyer, Delhi seller
    expect(isInterStateSupply("07", "27")).toBe(true); // Delhi buyer, Maharashtra seller
  });

  it("conservative default: missing customer state → false", () => {
    expect(isInterStateSupply(null, "07")).toBe(false);
    expect(isInterStateSupply(undefined, "07")).toBe(false);
    expect(isInterStateSupply("", "07")).toBe(false);
  });

  it("conservative default: missing seller state → false (even for a real different-state customer)", () => {
    // This is the degraded case the /setup GST profile must prevent: with no
    // seller state_code we cannot know the head, so we fall back to intra-state.
    expect(isInterStateSupply("27", null)).toBe(false);
    expect(isInterStateSupply("27", undefined)).toBe(false);
    expect(isInterStateSupply("27", "")).toBe(false);
  });

  it("both missing → false", () => {
    expect(isInterStateSupply(null, null)).toBe(false);
  });
});

describe("isExportSupply", () => {
  it("India (any spelling) → domestic, not export", () => {
    for (const c of ["India", "india", "IN", "in", "Bharat", "IND"]) {
      expect(isExportSupply(c)).toBe(false);
    }
  });

  it("any other country → export", () => {
    for (const c of ["United States", "USA", "US", "Singapore", "UAE", "Germany"]) {
      expect(isExportSupply(c)).toBe(true);
    }
  });

  it("conservative default: missing/empty country → domestic (never accidentally zero-rate)", () => {
    expect(isExportSupply(null)).toBe(false);
    expect(isExportSupply(undefined)).toBe(false);
    expect(isExportSupply("")).toBe(false);
    expect(isExportSupply("   ")).toBe(false);
  });
});

describe("gstTreatment", () => {
  it("export beats the state comparison", () => {
    // Even if a stray Indian state code is present, a foreign country → export.
    expect(gstTreatment("USA", "27", "07")).toBe("export");
    expect(gstTreatment("Singapore", null, "07")).toBe("export");
  });

  it("domestic same-state → intra_state (CGST + SGST)", () => {
    expect(gstTreatment("India", "07", "07")).toBe("intra_state");
    expect(gstTreatment(null, "27", "27")).toBe("intra_state");
  });

  it("domestic different-state → inter_state (IGST)", () => {
    expect(gstTreatment("India", "27", "07")).toBe("inter_state");
  });

  it("unknown country + unknown state → intra_state (safe default, taxed)", () => {
    expect(gstTreatment(null, null, "07")).toBe("intra_state");
  });
});

describe("isInterStateSupply — GSTIN fallback (third argument)", () => {
  const DELHI_GSTIN     = "07ABDCA0298H1ZP";   // the production seller's own
  const KARNATAKA_GSTIN = "29AAGCB1286Q1Z0";   // check char minted via isValidGstin
  const SELLER = "07";

  it("fills in a missing customer state from their GSTIN", () => {
    // Without the fallback this is the 36-customer production case: no state
    // code, so CGST+SGST, even though the GSTIN says Karnataka.
    expect(isInterStateSupply(null, SELLER)).toBe(false);
    expect(isInterStateSupply(null, SELLER, { customerGstin: KARNATAKA_GSTIN })).toBe(true);
  });

  it("fills in a missing SELLER state too", () => {
    expect(isInterStateSupply("29", null, { sellerGstin: DELHI_GSTIN })).toBe(true);
  });

  it("still says intra-state when the GSTIN is the same state", () => {
    expect(isInterStateSupply(null, SELLER, { customerGstin: DELHI_GSTIN })).toBe(false);
  });

  it("ignores a GSTIN that fails the checksum", () => {
    // A dummy or mistyped GSTIN must never decide a tax head.
    expect(isInterStateSupply(null, SELLER, { customerGstin: "29AAGCB1286Q1ZZ" })).toBe(false);
    expect(isInterStateSupply(null, SELLER, { customerGstin: "GUABCDE1234F1Z5" })).toBe(false);
  });

  it("an entered state code beats the GSTIN", () => {
    // Registered in Karnataka, billed at a Delhi branch: the human's entry wins.
    expect(isInterStateSupply("07", SELLER, { customerGstin: KARNATAKA_GSTIN })).toBe(false);
  });

  it("treats an unpadded state code as the same state", () => {
    // Entered codes are hand-typed and often unpadded; derived ones never are.
    expect(isInterStateSupply("7", SELLER, { customerGstin: KARNATAKA_GSTIN })).toBe(false);
    expect(isInterStateSupply("7", "07")).toBe(false);
  });

  it("omitting the third argument behaves exactly as before", () => {
    expect(isInterStateSupply(null, SELLER)).toBe(false);
    expect(isInterStateSupply("29", SELLER)).toBe(true);
    expect(isInterStateSupply("07", SELLER)).toBe(false);
  });
});

describe("placeOfSupplyLabel (R-043, Rule 46 state name + code)", () => {
  it("names the state and code from the code frozen on the invoice", () => {
    expect(placeOfSupplyLabel({ posCode: "29", interState: true })).toBe("Karnataka (29) · IGST");
    expect(placeOfSupplyLabel({ posCode: "07", interState: false })).toBe("Delhi (07) · CGST + SGST");
  });
  it("export is 96 with the country", () => {
    expect(placeOfSupplyLabel({ posCode: "96", interState: false, country: "United States" })).toBe("Export · United States (96)");
    expect(placeOfSupplyLabel({ isExport: true, interState: false })).toBe("Export · outside India (96)");
  });
  it("no frozen code keeps the old wording — never a guessed state", () => {
    expect(placeOfSupplyLabel({ posCode: null, interState: true })).toBe("Inter-state (IGST)");
    expect(placeOfSupplyLabel({ posCode: "", interState: false })).toBe("Intra-state (CGST + SGST)");
  });
});

describe("frozenParty (R-043 — GSTR-1 reads the invoice, not today's customer)", () => {
  const live = { gstin: "27AAGCB1286Q1Z9", stateCode: "27", state: "Maharashtra", country: "India" };
  it("uses the GSTIN and state frozen at issue, not today's", () => {
    const p = frozenParty({ customer_gstin: "29AAGCB1286Q1Z0", pos_state_code: "29", seller_state_code: "07", customer_country: "India" }, live);
    expect(p).toEqual({ gstin: "29AAGCB1286Q1Z0", stateCode: "29", state: "Karnataka", country: "India" });
  });
  it("unregistered at issue stays unregistered even if they registered later", () => {
    expect(frozenParty({ customer_gstin: null, pos_state_code: "07", seller_state_code: "07" }, live).gstin).toBeNull();
  });
  it("export (96) has no Indian state", () => {
    const p = frozenParty({ pos_state_code: "96", customer_country: "United States", seller_state_code: "07" }, live);
    expect(p.stateCode).toBeNull();
    expect(p.country).toBe("United States");
  });
  it("no snapshot → today's customer, as before", () => {
    expect(frozenParty({ customer_gstin: null }, live)).toEqual(live);
    expect(frozenParty(null, live)).toEqual(live);
  });
});

/* R-431 (board R-406): Abhishek's local test — a workspace with NO company state quoted a
   Haryana customer "✓ Intra-state → CGST + SGST", took the payment, and the invoice later
   came out IGST. An unknown state on EITHER side is "unknown", never intra-state. */
describe("supplyHead — never assume intra-state (R-431)", () => {
  it("seller (company) state empty → seller_state_missing, not intra-state", () => {
    const h = supplyHead({ isExport: false, buyerStateCode: "06", sellerStateCode: null });
    expect(h.kind).toBe("seller_state_missing");
    expect(h.known).toBe(false);
    expect(h.interState).toBe(false);
    // isInterStateSupply's arithmetic default is exactly the guess this replaces
    expect(isInterStateSupply("06", null)).toBe(false);
  });

  it("blank / whitespace company state counts as empty", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "06", sellerStateCode: "  " }).kind).toBe("seller_state_missing");
  });

  it("customer state empty → buyer_state_missing", () => {
    const h = supplyHead({ isExport: false, buyerStateCode: null, sellerStateCode: "07" });
    expect(h.kind).toBe("buyer_state_missing");
    expect(h.known).toBe(false);
  });

  it("both empty → the company state is asked for first (one click to fix)", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "", sellerStateCode: "" }).kind).toBe("seller_state_missing");
  });

  it("same state → intra_state (CGST + SGST)", () => {
    const h = supplyHead({ isExport: false, buyerStateCode: "07", sellerStateCode: "07" });
    expect(h).toEqual({ kind: "intra_state", known: true, interState: false });
  });

  it("same state, unpadded code → still intra_state", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "7", sellerStateCode: "07" }).kind).toBe("intra_state");
  });

  it("different state → inter_state (IGST)", () => {
    const h = supplyHead({ isExport: false, buyerStateCode: "06", sellerStateCode: "07" });
    expect(h).toEqual({ kind: "inter_state", known: true, interState: true });
  });

  it("export needs no Indian state on either side", () => {
    expect(supplyHead({ isExport: true, buyerStateCode: null, sellerStateCode: null }).kind).toBe("export");
  });
});
