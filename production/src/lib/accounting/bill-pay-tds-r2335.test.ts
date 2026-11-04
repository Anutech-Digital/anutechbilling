/**
 * R-2335: Bills → Pay takes the vendor's TDS — the same rules as Reconcile (R-2320's planTds).
 * Owner's case: COGS bill ₹10,000 + GST = ₹11,800 from a vendor already paid ₹1,00,000 this FY
 * (194C crossed) → TDS ₹200, ₹11,600 from the bank, ₹0 due.
 */
import { describe, expect, it } from "vitest";
import { billPayTds, payVendorBillArgs, type BillForPay } from "./bill-pay-tds";

const bill = (over: Partial<BillForPay> = {}): BillForPay => ({
  id: "BILL-1", bill_no: "G-1", bill_date: "2026-10-01", due_date: null, category: "COGS-Workspace",
  subtotal: 10_000, total: 11_800, paid_amount: 0, currency: "INR", ...over,
});
const crossed = { base: 100_000, baseWithoutTds: 0 };
const PAN = "AACCG2335A";

describe("billPayTds (R-2335)", () => {
  it("194C above the year's limit → 2% of the value before GST; cash = what is owed less TDS", () => {
    const t = billPayTds(bill(), { section: "194C", pan: PAN, fyOthers: crossed, off: false });
    expect(t.tds).toBe(200);
    expect(t.section).toBe("194C");
    expect(t.cash).toBe(11_600);
    expect(t.reason).toMatch(/194C/);
    expect(t.belowThreshold).toBe(false);
  });

  it("below the threshold → no TDS, the owner may override with a reason (section's rate)", () => {
    const below = billPayTds(bill(), { section: "194C", pan: PAN, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false });
    expect(below.tds).toBe(0);
    expect(below.belowThreshold).toBe(true);
    expect(below.cash).toBe(11_800);
    const short = billPayTds(bill(), { section: "194C", pan: PAN, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false, override: "ok" });
    expect(short.tds).toBe(0);
    const ovr = billPayTds(bill(), { section: "194C", pan: PAN, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false, override: "Deducted in Zoho" });
    expect(ovr.tds).toBe(200);
    expect(ovr.override).toBe("Deducted in Zoho");
    expect(ovr.reason).toMatch(/Owner override/);
  });

  it("a part-paid bill takes no services TDS (it goes with the first payment); 'No TDS' takes none", () => {
    expect(billPayTds(bill({ paid_amount: 5_000 }), { section: "194C", pan: PAN, fyOthers: crossed, off: false }).tds).toBe(0);
    expect(billPayTds(bill(), { section: "194C", pan: PAN, fyOthers: crossed, off: true }).tds).toBe(0);
    expect(billPayTds(bill(), { section: "", pan: PAN, fyOthers: crossed, off: false }).tds).toBe(0);
  });

  it("a foreign-currency bill takes no TDS here", () => {
    expect(billPayTds(bill({ currency: "USD" }), { section: "194C", pan: PAN, fyOthers: crossed, off: false }).tds).toBe(0);
  });

  it("194Q stays the database's figure (R-1891)", () => {
    const q194 = new Map([["BILL-1", { doc_id: "BILL-1", fy_start: "2026-04-01", fy_before: 6_000_000, base: 10_000, rate_pct: 0.1, no_pan: false, tds_total: 10, tds_already: 0, tds_due: 10, buyer: true }]]);
    const t = billPayTds(bill(), { section: "194Q", pan: PAN, fyOthers: crossed, off: false, q194 });
    expect(t.tds).toBe(10);
    expect(t.section).toBe("194Q");
    const notBuyer = new Map([["BILL-1", { ...q194.get("BILL-1")!, buyer: false }]]);
    expect(billPayTds(bill(), { section: "194Q", pan: PAN, fyOthers: crossed, off: false, q194: notBuyer }).tds).toBe(0);
  });
});

describe("payVendorBillArgs (R-2335)", () => {
  it("sends the 8 arguments; the reason only with TDS", () => {
    expect(payVendorBillArgs({ billId: "B", amount: 11_600.4, paidOn: "2026-10-10", bankAccountId: "A", method: "upi", tds: 200, tdsSection: "194C", tdsOverride: "  " }))
      .toEqual({ p_bill_id: "B", p_amount: 11_600, p_paid_on: "2026-10-10", p_bank_account_id: "A", p_method: "upi", p_tds_amount: 200, p_tds_section: "194C", p_tds_override_reason: null });
    expect(payVendorBillArgs({ billId: "B", amount: 100, paidOn: "2026-10-10", bankAccountId: "A", tds: 0, tdsSection: "194C", tdsOverride: "Deducted in Zoho" }))
      .toEqual({ p_bill_id: "B", p_amount: 100, p_paid_on: "2026-10-10", p_bank_account_id: "A", p_method: null, p_tds_amount: 0, p_tds_section: null, p_tds_override_reason: null });
    expect(payVendorBillArgs({ billId: "B", amount: 5_800, paidOn: "2026-10-10", bankAccountId: "A", tds: 100, tdsSection: "194C", tdsOverride: "Deducted in Zoho" }).p_tds_override_reason)
      .toBe("Deducted in Zoho");
  });
});
