/**
 * R-1576 — a vendor bill's GST is credit only when it can be credit.
 * Before: report.ts (Input: vendor bills block), report_pnl / report_balance_sheet
 * `bills_gst` took every bill's cgst+sgst+igst as ITC — proforma and no-GSTIN bills too.
 */
import { describe, it, expect } from "vitest";
import { billItcEligibility, effectiveBillDocType, splitBillItc, mergeItcSplits, splitBillGroups } from "./bill-itc";
import { splitItc } from "./itc";

const GSTIN_DL = "07AAACA1234A1Z5";   // Delhi
const GSTIN_MH = "27AAACM1234B1Z3";   // Maharashtra
const base = { vendor_gstin: GSTIN_DL, category: "COGS-Workspace", cgst: 900, sgst: 900, igst: 0, ownStateCode: "07" };

describe("billItcEligibility", () => {
  it("a normal tax invoice from a registered vendor — credit, unchanged", () => {
    expect(billItcEligibility({ ...base, document_type: "tax_invoice" })).toEqual({ eligible: true, reason: null });
  });

  it("a PROFORMA — no credit, says why", () => {
    const v = billItcEligibility({ ...base, document_type: "proforma" });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/Proforma/);
  });

  it("no vendor GSTIN — no credit, even when called a tax invoice", () => {
    const v = billItcEligibility({ ...base, vendor_gstin: "", document_type: "tax_invoice" });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/GSTIN/);
  });

  it("bill of supply / other — no credit", () => {
    expect(billItcEligibility({ ...base, document_type: "bill_of_supply" }).eligible).toBe(false);
    expect(billItcEligibility({ ...base, document_type: "other" }).eligible).toBe(false);
  });

  it("old row (document_type NULL): tax invoice only when it has a GSTIN", () => {
    expect(effectiveBillDocType(null, GSTIN_DL)).toBe("tax_invoice");
    expect(effectiveBillDocType(null, null)).toBe("other");
    expect(effectiveBillDocType("proforma", GSTIN_DL)).toBe("proforma");
    expect(billItcEligibility({ ...base, document_type: null }).eligible).toBe(true);
    expect(billItcEligibility({ ...base, document_type: null, vendor_gstin: null }).eligible).toBe(false);
  });

  it("another state's vendor charging CGST+SGST — that state's tax, no credit here", () => {
    const v = billItcEligibility({ ...base, vendor_gstin: GSTIN_MH, document_type: "tax_invoice" });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/another state \(27\)/);
  });

  it("another state's vendor charging IGST — credit", () => {
    expect(billItcEligibility({ ...base, vendor_gstin: GSTIN_MH, cgst: 0, sgst: 0, igst: 1800, document_type: "tax_invoice" }).eligible).toBe(true);
  });

  it("same state vendor charging only IGST — wrong head, no credit", () => {
    expect(billItcEligibility({ ...base, cgst: 0, sgst: 0, igst: 1800, document_type: "tax_invoice" }).eligible).toBe(false);
  });

  it("own state unknown — state check skipped, nothing guessed", () => {
    expect(billItcEligibility({ ...base, vendor_gstin: GSTIN_MH, ownStateCode: null, document_type: "tax_invoice" }).eligible).toBe(true);
  });

  it("s.17(5) blocked category — the same list expenses use", () => {
    const v = billItcEligibility({ ...base, category: "Staff Welfare", document_type: "tax_invoice" });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/17\(5\)/);
  });

  it("no GST on the bill — nothing to claim, no reason", () => {
    expect(billItcEligibility({ ...base, cgst: 0, sgst: 0, document_type: "proforma" })).toEqual({ eligible: false, reason: null });
  });
});

describe("splitBillItc / splitBillGroups / mergeItcSplits", () => {
  it("only the tax invoice counts; the rest is cost, by reason", () => {
    const s = splitBillItc([
      { ...base, document_type: "tax_invoice" },
      { ...base, document_type: "proforma" },
      { ...base, vendor_gstin: null, document_type: null },
    ]);
    expect(s.eligible).toBe(1800);
    expect(s.blocked).toBe(3600);
    expect(s.blockedByReason).toHaveLength(2);
  });

  it("groups carry n into the count", () => {
    const s = splitBillGroups([{ document_type: "proforma", category: "COGS-M365", vendorGstin: GSTIN_DL, cgst: 900, sgst: 900, igst: 0, n: 3, ownStateCode: "07" }]);
    expect(s.blocked).toBe(1800);
    expect(s.blockedByReason[0].count).toBe(3);
  });

  it("expense + bill splits merge by reason", () => {
    const exp = splitItc([{ gst_paid: 500, bill_type: "gst", category: "Software", vendorGstin: null }]);
    const bill = splitBillItc([{ ...base, vendor_gstin: null, document_type: "tax_invoice" }]);
    const m = mergeItcSplits(exp, bill);
    expect(m.blocked).toBe(2300);
    expect(m.blockedByReason).toEqual([{ reason: expect.stringMatching(/GSTIN/), amount: 2300, count: 2 }]);
  });

  it("expenses are unchanged by this card", () => {
    expect(splitItc([{ gst_paid: 1800, bill_type: "gst", category: "Software", vendorGstin: GSTIN_DL }]).eligible).toBe(1800);
  });
});
