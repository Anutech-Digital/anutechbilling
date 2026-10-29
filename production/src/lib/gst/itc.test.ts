import { describe, it, expect } from "vitest";
import { itcEligibility, splitItc, isGstin } from "./itc";

const G = "07AABCU9603R1ZM";

describe("input tax credit on expenses", () => {
  it("a GST tax invoice from a registered vendor in an ordinary category is credit", () => {
    expect(itcEligibility({ gst_paid: 1800, bill_type: "gst", category: "Software", vendorGstin: G })).toEqual({ eligible: true, reason: null });
  });

  it("no GST → nothing to decide", () => {
    expect(itcEligibility({ gst_paid: 0, bill_type: "gst", category: "Software", vendorGstin: G })).toEqual({ eligible: false, reason: null });
  });

  it("kaccha / no bill, no GSTIN, blocked category → cost, with the reason", () => {
    expect(itcEligibility({ gst_paid: 100, bill_type: "kaccha", category: "Software", vendorGstin: G }).reason).toMatch(/Not a GST tax invoice/);
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Software", vendorGstin: null }).reason).toMatch(/box is empty/);   // R-2056
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Software", vendorGstin: "ABC" }).reason).toMatch(/looks wrong/);   // R-2056: wrong format, not "empty"
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Staff Welfare", vendorGstin: G }).reason).toMatch(/17\(5\)\(b\)/);
    expect(itcEligibility({ gst_paid: 100, bill_type: "gst", category: "Business Promotion", vendorGstin: G }).reason).toMatch(/17\(5\)\(h\)/);
  });

  it("business travel and insurance are not blocked wholesale", () => {
    expect(itcEligibility({ gst_paid: 90, bill_type: "gst", category: "Travel", vendorGstin: G }).eligible).toBe(true);
  });

  it("splits GST into credit and cost, grouped by reason", () => {
    const s = splitItc([
      { gst_paid: 1800, bill_type: "gst", category: "Software", vendorGstin: G },
      { gst_paid: 900,  bill_type: "gst", category: "Hosting",  vendorGstin: G },
      { gst_paid: 180,  bill_type: "kaccha", category: "Office Supplies", vendorGstin: null },
      { gst_paid: 90,   bill_type: "gst", category: "Staff Welfare", vendorGstin: G },
      { gst_paid: 45,   bill_type: "gst", category: "Staff Welfare", vendorGstin: G },
      { gst_paid: 0,    bill_type: "gst", category: "Rent", vendorGstin: G },
    ]);
    expect(s.eligible).toBe(2700);
    expect(s.blocked).toBe(315);
    expect(s.blockedByReason[0]).toEqual({ reason: expect.stringMatching(/Not a GST tax invoice/), amount: 180, count: 1 });
    expect(s.blockedByReason[1]).toEqual({ reason: expect.stringMatching(/17\(5\)\(b\)/), amount: 135, count: 2 });
  });

  it("GSTIN shape", () => {
    expect(isGstin("07ABDCA0298H1ZP")).toBe(true);
    expect(isGstin(" 07abdca0298h1zp ")).toBe(true);
    expect(isGstin("07ABDCA0298H1Z")).toBe(false);
    expect(isGstin("")).toBe(false);
  });
});
