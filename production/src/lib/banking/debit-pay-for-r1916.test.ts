/**
 * R-1916 slice 1: TDS withheld on a vendor ADVANCE paid from the bank — the owner's path:
 * a contractor's ₹90,000 bank line kept as an advance with 194J ₹10,000 withheld.
 */
import { describe, it, expect } from "vitest";
import { advanceTdsFromCash, payArgs, resultLines, type PayInput, type VendorPayResult } from "./debit-pay-for";
import { COGS_BILL_TDS_KINDS } from "@/lib/queries/cogs-bill-tds";

const base: PayInput = {
  transactionId: "t1", vendorId: "v1", newVendor: null, items: [], newBill: null,
  advance: 90000, advanceCategory: "Professional Fees", bankCharge: 0, note: null,
};

describe("R-1916 advanceTdsFromCash — the bank paid gross − TDS", () => {
  it("194JB 10%: ₹90,000 paid → TDS ₹10,000 (advance ₹1,00,000)", () => {
    expect(advanceTdsFromCash(90000, "194JB", "ABCPS1916K")).toBe(10000);
  });
  it("194C company 2%: ₹98,000 paid → TDS ₹2,000; individual contractor 1%: ₹99,000 → ₹1,000", () => {
    expect(advanceTdsFromCash(98000, "194C", "AAACB1914A")).toBe(2000);
    expect(advanceTdsFromCash(99000, "194C", "ABCPS1916K")).toBe(1000);
  });
  it("no PAN → 20% (s.206AA): ₹80,000 paid → TDS ₹20,000", () => {
    expect(advanceTdsFromCash(80000, "194JB", null)).toBe(20000);
  });
  it("unknown / no section → null; no cash → 0", () => {
    expect(advanceTdsFromCash(90000, "", "ABCPS1916K")).toBeNull();
    expect(advanceTdsFromCash(90000, "XYZ", "ABCPS1916K")).toBeNull();
    expect(advanceTdsFromCash(0, "194C", "AAACB1914A")).toBe(0);
  });
});

describe("R-1916 payArgs — the advance's TDS reaches the 12-argument RPC", () => {
  it("TDS on the advance → p_advance_tds / section / override", () => {
    const a = payArgs({ ...base, advanceTds: 10000, advanceTdsSection: "194JB", advanceTdsOverride: null });
    expect(a).toMatchObject({ p_advance: 90000, p_advance_tds: 10000, p_advance_tds_section: "194JB", p_advance_tds_override_reason: null });
  });
  it("no TDS → the 9-argument call, unchanged (no extra keys)", () => {
    const a = payArgs({ ...base, advanceTds: 0, advanceTdsSection: "194JB" });
    expect(a).not.toHaveProperty("p_advance_tds");
    expect(a).not.toHaveProperty("p_advance_tds_section");
    expect(a).not.toHaveProperty("p_advance_tds_override_reason");
  });
  it("TDS without an advance is never sent", () => {
    const a = payArgs({ ...base, advance: 0, advanceTds: 500, advanceTdsSection: "194C" });
    expect(a).not.toHaveProperty("p_advance_tds");
  });
});

describe("R-1916 resultLines — the advance says paid + TDS", () => {
  it("₹1,00,000 advance = ₹90,000 paid + TDS ₹10,000", () => {
    const r: VendorPayResult = {
      vendor_id: "v1", vendor_name: "Sharma Design Studio", vendor_created: false, bank_amount: 90000, paid: [], new_bill: null,
      advance: { id: "a1", amount: 100000, category: "Professional Fees", cash: 90000, tds: 10000, tds_section: "194JB" },
      bank_charge: null, tds_total: 10000, tds_section: "194JB",
    };
    const text = resultLines(r).map((l) => l.text).join("\n");
    expect(text).toContain("₹1,00,000 kept as an advance");
    expect(text).toContain("₹90,000 paid + TDS ₹10,000");
    expect(text).toContain("TDS ₹10,000");
  });
});

describe("R-1916 the 26Q / TDS-payable feed reads advance rows", () => {
  it("kinds include advance", () => {
    expect([...COGS_BILL_TDS_KINDS]).toEqual(["bill", "new_bill", "advance"]);
  });
});
