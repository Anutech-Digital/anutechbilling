/** R-2588: un-reconciling a vendor advance with TDS (R-1916) names the gross and the TDS taken off. */
import { describe, expect, it } from "vitest";
import { vendorUndoLegLine, type VendorUndoLeg } from "./unreconcile";

const leg = (over: Partial<VendorUndoLeg>): VendorUndoLeg => ({
  id: "l1", kind: "advance", cash: 90000, tds_amount: 10000, tds_section: "194JB", doc_type: "advance",
  doc_id: "A1", doc_no: null, doc_total: null, before_paid: null, before_status: null,
  removed: true, href: "/accounting/prepaid", ...over,
});

describe("R-2588 un-reconcile text — advance with TDS", () => {
  it("₹90,000 + TDS ₹10,000 → the ₹1,00,000 advance and its TDS are named", () => {
    expect(vendorUndoLegLine(leg({}))).toBe("Advance of ₹1,00,000 to the vendor (₹90,000 paid + TDS ₹10,000) is removed; TDS ₹10,000 (194J(b)) taken off");
  });
  it("a plain advance reads as before", () => {
    expect(vendorUndoLegLine(leg({ tds_amount: 0, tds_section: null }))).toBe("Advance of ₹90,000 to the vendor is removed");
  });
});
