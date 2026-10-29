/**
 * R-2056 (28 Oct 2026) — owner's real path: a foreign online-service (OIDAR) bill in USD whose
 * "VAT Registration India GST" is an OIDAR GSTIN. Add bill said "Vendor has no GSTIN", because
 * GSTIN_RE only knew the domestic layout.
 *
 * OIDAR layout — GSTN's own API portal (developer.gst.gov.in/apiportal/taxpayer/returns),
 * "REGEX_7" for gstin(OIDAR): [9][9][0-9]{2}[a-zA-Z]{3}[0-9]{5}[O][S][0-9a-zA-Z]{1},
 * sample 9918IND29061OSS. Synthetic GSTINs below in that SHAPE — no real invoice in the repo.
 */
import { describe, it, expect } from "vitest";
import { isGstin, isOidarGstin, normalizeGstin, gstinIssue, itcEligibility } from "./itc";
import { billItcEligibility } from "./bill-itc";

const OIDAR_SAMPLE = "9918IND29061OSS";      // GSTN portal's own sample
const OIDAR_USA    = "9924USA00001OSX";      // synthetic, same shape as a US SaaS invoice
const DL = "07ABCDE1234F1Z5";

describe("normalizeGstin — spaces and dashes go", () => {
  it("strips spaces, dashes, dots; upper-cases", () => {
    expect(normalizeGstin("07 ABCDE 1234F1Z5")).toBe(DL);
    expect(normalizeGstin(" 07-abcde-1234f1z5 ")).toBe(DL);
    expect(normalizeGstin("9918 IND 29061 OSS")).toBe(OIDAR_SAMPLE);
    expect(normalizeGstin(null)).toBe("");
  });
  it("a spaced domestic GSTIN counts as a GSTIN", () => {
    expect(isGstin("07 ABCDE 1234F1Z5")).toBe(true);
    expect(isGstin("07-ABCDE-1234F1Z5")).toBe(true);
  });
});

describe("isOidarGstin — GSTN REGEX_7", () => {
  it("accepts the OIDAR layout (99 + year + country + serial + OS + check)", () => {
    expect(isOidarGstin(OIDAR_SAMPLE)).toBe(true);
    expect(isOidarGstin(OIDAR_USA)).toBe(true);
    expect(isOidarGstin(" 9924usa00001osx ")).toBe(true);
  });
  it("rejects domestic, too short, or not state 99", () => {
    expect(isOidarGstin(DL)).toBe(false);
    expect(isOidarGstin("9924USA00001OS")).toBe(false);
    expect(isOidarGstin("0724USA00001OSX")).toBe(false);
    expect(isOidarGstin("9924USA00001NRX")).toBe(false);
  });
  it("an OIDAR GSTIN is NOT a domestic GSTIN (it never shows in GSTR-2B)", () => {
    expect(isGstin(OIDAR_USA)).toBe(false);
  });
});

describe("gstinIssue — empty vs wrong vs OIDAR", () => {
  it("each case its own code", () => {
    expect(gstinIssue("")).toBe("empty");
    expect(gstinIssue("   ")).toBe("empty");
    expect(gstinIssue(null)).toBe("empty");
    expect(gstinIssue("ABC")).toBe("invalid");
    expect(gstinIssue("07ABCDE1234F1Z")).toBe("invalid");
    expect(gstinIssue(OIDAR_USA)).toBe("oidar");
    expect(gstinIssue(DL)).toBeNull();
    expect(gstinIssue("07 ABCDE 1234F1Z5")).toBeNull();
  });
});

describe("Add bill — the owner's USD bill", () => {
  const usdBill = { document_type: "tax_invoice", category: "Software", cgst: 0, sgst: 0, igst: 58.5, ownStateCode: "07" };

  it("OIDAR GSTIN → its own message (not 'no GSTIN') with the next step", () => {
    const v = billItcEligibility({ ...usdBill, vendor_gstin: OIDAR_USA });
    expect(v.eligible).toBe(false);
    expect(v.reason).not.toMatch(/no GSTIN/i);
    expect(v.reason).toMatch(/OIDAR/);
    expect(v.reason).toMatch(/GSTR-2B/);
    expect(v.reason).toMatch(/Add your GSTIN in the vendor's billing settings/);
    expect(v.reason).toMatch(/reverse charge/);
  });

  it("empty box and wrong format say different things", () => {
    const empty = billItcEligibility({ ...usdBill, vendor_gstin: "" }).reason;
    const wrong = billItcEligibility({ ...usdBill, vendor_gstin: "07ABCDE12" }).reason;
    expect(empty).toMatch(/Vendor GSTIN box is empty/);
    expect(wrong).toMatch(/This GSTIN looks wrong \(15 characters, no spaces\)/);
    expect(empty).not.toBe(wrong);
  });

  it("a spaced domestic GSTIN on a Delhi bill still gets credit", () => {
    const v = billItcEligibility({ ...usdBill, igst: 0, cgst: 90, sgst: 90, vendor_gstin: "07 ABCDE 1234F1Z5" });
    expect(v).toEqual({ eligible: true, reason: null });
  });

  it("expenses use the same words", () => {
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Software", vendorGstin: OIDAR_USA }).reason).toMatch(/OIDAR/);
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Software", vendorGstin: "" }).reason).toMatch(/box is empty/);
  });
});
