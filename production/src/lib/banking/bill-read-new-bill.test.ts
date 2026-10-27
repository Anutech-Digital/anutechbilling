/* R-2005 — a bill read by the AI fills "The bill is not in the books yet — record it now" on a
   money-out bank line, and says when the bill's vendor is not the vendor picked for the line. */
import { describe, expect, it } from "vitest";

import { billVendorCheck, newBillFromRead } from "./bill-read-new-bill";
import type { NewBillDraft, VendorLite } from "./debit-pay-for";

const CATS = { expense: ["Professional Services", "Advertising", "Other"], cogs: ["COGS-Workspace", "COGS-Other"] } as const;
const blank: NewBillDraft = { kind: "expense", billNo: "", billDate: "2026-10-11", category: "", taxable: 0, gst: 0, itc: true, pay: 0 };
const read = (fields: Record<string, unknown>, resale: string | null = null) => ({ fields, buyer: null, resale });

describe("R-2005 newBillFromRead", () => {
  it("an expense bill: number, date, value before GST, GST, category from the reader", () => {
    const out = newBillFromRead(blank, read({
      bill_no: "BPH-77", bill_date: "2026-10-09", subtotal: 6000, cgst: 540, sgst: 540, igst: 0, total: 7080,
      expense_category: "Advertising", currency: "INR", document_type: "tax_invoice",
    }), CATS);
    expect(out.bill).toEqual({ kind: "expense", billNo: "BPH-77", billDate: "2026-10-09", category: "Advertising", taxable: 6000, gst: 1080, itc: true, pay: 0 });
    expect(out.note).toBeNull();
  });

  it("a bill for a product we resell → COGS bill with the reader's COGS head", () => {
    const out = newBillFromRead(blank, read({ bill_no: "G-9", subtotal: 20000, igst: 3600, category_guess: "COGS-Workspace" }, "Google Workspace"), CATS);
    expect(out.bill).toMatchObject({ kind: "cogs", category: "COGS-Workspace", taxable: 20000, gst: 3600 });
  });

  it("paise are rounded to rupees; no subtotal → total less GST", () => {
    const out = newBillFromRead(blank, read({ total: 1180.4, cgst: 90.2, sgst: 90.2 }), CATS);
    expect(out.bill).toMatchObject({ taxable: 1000, gst: 180 });
  });

  it("keeps what the reader did not find; a category off our list is not used", () => {
    const prev = { ...blank, billNo: "typed", category: "Professional Services" };
    const out = newBillFromRead(prev, read({ subtotal: 500, expense_category: "Made Up" }), CATS);
    expect(out.bill).toMatchObject({ billNo: "typed", billDate: "2026-10-11", category: "Professional Services", taxable: 500, gst: 0 });
  });

  it("a proforma gives no input credit, and says so", () => {
    const out = newBillFromRead(blank, read({ subtotal: 1000, igst: 180, document_type: "proforma" }), CATS);
    expect(out.bill.itc).toBe(false);
    expect(out.note).toMatch(/proforma, not a tax invoice — no GST input credit/);
  });

  it("a foreign-currency bill fills number and date only — the ₹ amounts are typed by hand", () => {
    const out = newBillFromRead(blank, read({ bill_no: "INV-1", bill_date: "2026-10-01", subtotal: 100, igst: 18, currency: "USD" }), CATS);
    expect(out.bill).toMatchObject({ billNo: "INV-1", billDate: "2026-10-01", taxable: 0, gst: 0 });
    expect(out.note).toBe("The bill is in USD — type the ₹ value before GST and the GST by hand.");
  });
});

const V: VendorLite[] = [
  { id: "v1", name: "Sharma Associates", gstin: "07AAKFS1866A1Z5" },
  { id: "v4", name: "Bansal Print House", gstin: "07AABCB2005A1Z1" },
];

describe("R-2005 billVendorCheck", () => {
  it("same vendor (GSTIN, or the name without Pvt Ltd / M/s) → nothing to say", () => {
    expect(billVendorCheck({ vendor_name: "Anything", vendor_gstin: "07aakfs1866a1z5" }, V[0], V)).toBeNull();
    expect(billVendorCheck({ vendor_name: "M/s. Sharma Associates Pvt Ltd" }, V[0], V)).toBeNull();
    expect(billVendorCheck({}, V[0], V)).toBeNull();
  });

  it("another vendor that is in the master → named, with that vendor to switch to", () => {
    expect(billVendorCheck({ vendor_name: "Bansal Print House", vendor_gstin: "07AABCB2005A1Z1" }, V[0], V))
      .toEqual({ readName: "Bansal Print House", readGstin: "07AABCB2005A1Z1", match: V[1] });
    expect(billVendorCheck({ vendor_name: "BANSAL PRINT HOUSE PVT. LTD." }, V[0], V)?.match?.id).toBe("v4");
  });

  it("a GSTIN that differs is a different vendor even when the names look alike", () => {
    expect(billVendorCheck({ vendor_name: "Sharma Associates", vendor_gstin: "29AAKFS1866A1Z9" }, V[0], V))
      .toEqual({ readName: "Sharma Associates", readGstin: "29AAKFS1866A1Z9", match: null });
  });

  it("a vendor not in the master → no match (the form offers it as a new vendor)", () => {
    expect(billVendorCheck({ vendor_name: "Bansal Traders", vendor_gstin: "07AAACB0000B1Z2" }, V[0], V))
      .toEqual({ readName: "Bansal Traders", readGstin: "07AAACB0000B1Z2", match: null });
  });

  it("a new vendor typed in the line is compared by name and GSTIN too", () => {
    expect(billVendorCheck({ vendor_name: "Bansal Traders" }, { name: "Bansal Traders", gstin: "" }, V)).toBeNull();
    expect(billVendorCheck({ vendor_name: "Bansal Print House" }, { name: "Bansal Traders", gstin: "" }, V)?.match?.id).toBe("v4");
  });
});
