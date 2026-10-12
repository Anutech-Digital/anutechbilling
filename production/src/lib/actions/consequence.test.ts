import { describe, it, expect } from "vitest";
import { formatDocumentNumber, seriesGap, isBlocked, effectiveDocCode, type SeriesState } from "./consequence";

const S: SeriesState = {
  prefix: "RV", docCode: "ADPL", fiscalYear: "FY2627",
  lastNumber: 39, documentCount: 0,
};

describe("formatDocumentNumber", () => {
  it("matches the shape the database allocates", () => {
    /* R-015 (29 Sep 2026) shortened this from 21 characters to 16. It said
       INV-TEST-2026-27-0008 until then, which is over the CGST Rule 46(b) limit.
       The number the operator is shown must be the one the database will mint —
       `document-number-format.test.ts` pins the two implementations together. */
    expect(formatDocumentNumber({ ...S, prefix: "INV", docCode: "TEST" }, 8))
      .toBe("INV-TEST-27-0008");
    expect(formatDocumentNumber(S, 40)).toBe("RV-ADPL-27-0040");
  });

  it("stays inside the 16-character CGST Rule 46(b) limit", () => {
    // The longest GST prefix (INV, RFV) with a full 4-character code and 4 digits.
    expect(formatDocumentNumber({ ...S, prefix: "INV", docCode: "ADPL" }, 9999).length).toBe(16);
    expect(formatDocumentNumber({ ...S, prefix: "RFV", docCode: "ADPL" }, 1).length).toBe(16);
  });

  it("caps an over-long doc code, as the SQL does", () => {
    /* Nothing constrains tenants.doc_code. A 6-character one would push the number back
       over 16 with no warning at all. */
    expect(formatDocumentNumber({ ...S, prefix: "INV", docCode: "TOOLONG" }, 1))
      .toBe("INV-TOOL-27-0001");
  });

  it("omits a missing doc code instead of printing 'null'", () => {
    /* Demo Co' tenant row has doc_code null. */
    expect(formatDocumentNumber({ ...S, docCode: null }, 3)).toBe("RV-27-0003");
    expect(formatDocumentNumber({ ...S, docCode: "  " }, 3)).toBe("RV-27-0003");
  });

  it("pads to four digits without truncating past them", () => {
    expect(formatDocumentNumber(S, 7)).toContain("-0007");
    expect(formatDocumentNumber(S, 10_432)).toContain("-10432");
  });

  it("passes an unrecognised fiscal-year format through unmangled", () => {
    expect(formatDocumentNumber({ ...S, fiscalYear: "2026-27" }, 1))
      .toBe("RV-ADPL-2026-27-0001");
  });
});

describe("seriesGap", () => {
  it("reports a counter running ahead of empty books", () => {
    /* ANUTECH's real state for receipt vouchers: 39 used, none held. */
    const g = seriesGap(S, "receipt voucher");
    expect(g?.tone).toBe("warning");
    expect(g?.text).toMatch(/39 numbers/);
    expect(g?.text).toMatch(/auditor/);
  });

  it("reports a partial gap with the right count and noun", () => {
    const g = seriesGap({ ...S, lastNumber: 10, documentCount: 8 }, "invoice");
    expect(g?.text).toMatch(/^2 numbers/);
    expect(g?.text).toContain("invoice against them");
  });

  it("says nothing when the series and the books agree", () => {
    /* A warning that fires on the healthy case is one nobody reads. */
    expect(seriesGap({ ...S, lastNumber: 8, documentCount: 8 }, "invoice")).toBeNull();
  });

  it("says nothing for an untouched or absent series", () => {
    expect(seriesGap({ ...S, lastNumber: 0, documentCount: 0 }, "invoice")).toBeNull();
    expect(seriesGap(null, "invoice")).toBeNull();
  });

  it("does not report a NEGATIVE gap as a gap", () => {
    /* More documents than numbers should never happen; if it does, it is a different
       bug and inventing a "-3 numbers" sentence would hide it. */
    expect(seriesGap({ ...S, lastNumber: 5, documentCount: 9 }, "invoice")).toBeNull();
  });

  it("gets singular and plural right", () => {
    expect(seriesGap({ ...S, lastNumber: 1, documentCount: 0 }, "invoice")?.text)
      .toMatch(/1 number\b/);
    expect(seriesGap({ ...S, lastNumber: 9, documentCount: 8 }, "invoice")?.text)
      .toMatch(/^1 number\b/);
  });
});

describe("isBlocked", () => {
  it("spots a warning that makes the action impossible", () => {
    expect(isBlocked([{ tone: "warning", text: "This quote has no amount, so nothing can be issued." }])).toBe(true);
  });

  it("does not treat an ordinary caution as a block", () => {
    /* An overpayment is a decision, not an impossibility — blocking it would stop a
       real payment a customer actually made. */
    expect(isBlocked([{ tone: "warning", text: "That is ₹5,000 MORE than the quote's ₹10,000." }])).toBe(false);
  });

  it("is false for facts alone", () => {
    expect(isBlocked([{ tone: "fact", text: "Records ₹1,000." }])).toBe(false);
    expect(isBlocked([])).toBe(false);
  });
});

describe("effectiveDocCode (R-095)", () => {
  it("empty doc_code falls back to the first 4 hex of the tenant id, like next_document_number", () => {
    expect(effectiveDocCode(null, "fbb976f1-9090-4f10-9726-0901bd144e42")).toBe("FBB9");
    expect(effectiveDocCode("  ", "fbb976f1-9090-4f10-9726-0901bd144e42")).toBe("FBB9");
  });
  it("a set doc_code wins, trimmed and capped at 4", () => {
    expect(effectiveDocCode(" ADPL ", "fbb976f1-9090-4f10-9726-0901bd144e42")).toBe("ADPL");
    expect(effectiveDocCode("ANUTECH", "fbb976f1-9090-4f10-9726-0901bd144e42")).toBe("ANUT");
  });
  it("the predicted number now matches the issued one (INV-FBB9-27-0008)", () => {
    const s: SeriesState = { prefix: "INV", docCode: effectiveDocCode(null, "fbb976f1-9090-4f10-9726-0901bd144e42"), fiscalYear: "FY2627", lastNumber: 7, documentCount: 7 };
    expect(formatDocumentNumber(s, 8)).toBe("INV-FBB9-27-0008");
  });
});
