/**
 * R-2343: the un-reconcile preview names a TDS section the way Reconcile and the 26Q working do
 * (R-2338's tds26qSection) — "194J(a)", not the stored code "194JA".
 */
import { describe, expect, it } from "vitest";
import { vendorUndoLegLine, type VendorUndoLeg } from "./unreconcile";

const leg = (over: Partial<VendorUndoLeg>): VendorUndoLeg => ({
  id: "l1", kind: "expense", cash: 49000, tds_amount: 1000, tds_section: "194JA", doc_type: "expense",
  doc_id: "EXP-1", doc_no: "SS-11", doc_total: 50000, before_paid: 49000, before_status: "paid",
  after_paid: 0, after_status: "unpaid", removed: false, href: "/accounting/expenses", ...over,
});

describe("R-2343 un-reconcile text — readable 194J labels", () => {
  it("194JA → 194J(a), never the raw code", () => {
    const line = vendorUndoLegLine(leg({}));
    expect(line).toContain("TDS ₹1,000 (194J(a)) taken off");
    expect(line).not.toContain("194JA");
  });

  it("194JB → 194J(b), 194JR → 194J(b) royalty, old plain 194J → 194J(b), 194C stays 194C", () => {
    expect(vendorUndoLegLine(leg({ tds_section: "194JB" }))).toContain("(194J(b)) taken off");
    expect(vendorUndoLegLine(leg({ tds_section: "194JR" }))).toContain("(194J(b) royalty) taken off");
    expect(vendorUndoLegLine(leg({ tds_section: "194J" }))).toContain("(194J(b)) taken off");
    expect(vendorUndoLegLine(leg({ tds_section: "194C" }))).toContain("(194C) taken off");
  });

  it("a deleted bill created from the line says the same label", () => {
    const line = vendorUndoLegLine(leg({ kind: "new_expense", removed: true }));
    expect(line).toContain("(194J(a)) taken off");
  });

  it("no section → no brackets", () => {
    expect(vendorUndoLegLine(leg({ tds_section: null }))).toContain("TDS ₹1,000 taken off");
  });
});
