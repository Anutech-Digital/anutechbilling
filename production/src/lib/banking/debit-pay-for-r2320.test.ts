// R-2320 — vendor TDS on COGS bill payments, and the owner's override below the threshold.
// Owner examples (staging money-out reconcile, 31 Oct):
//   1. Google COGS bill ₹1,18,000 (₹1,00,000 + GST), Zoho deducted 194C 2% = ₹2,000 → bank ₹1,16,000
//   2. Sidhshree COGS bill — same 2%, the TDS must not stay "due" on the bill
//   3. Pankaj CA ₹16,200 (194J) → the app says "within the limit"; Zoho deducted 10% = ₹1,620,
//      bank ₹14,580 → only the owner, with a reason, can take it.
import { describe, it, expect } from "vitest";
import {
  newBillTds, overrideTds, payArgs, planTds, preselect, tdsMap, itemKey, cashDue, type VendorOpenItem,
} from "./debit-pay-for";
import { tdsDecision, tdsRatePct } from "@/lib/accounting/tds-deductor";

const cogs = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "vendor_bill", doc_id: "G1", bill_no: "G-1", doc_date: "2026-10-01", due_date: null, category: "COGS-Workspace",
  total: 118000, amount_due: 118000, gst: 18000, tds_base: 100000, tds_amount: 0, tds_section: null, can_part: true, in_run: null, ...o,
});
const exp = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "expense", doc_id: "P1", bill_no: "PK-1", doc_date: "2026-10-03", due_date: null, category: "Professional Services",
  total: 16200, amount_due: 16200, gst: 0, tds_base: 16200, tds_amount: 0, tds_section: null, can_part: true, in_run: null, ...o,
});
const COMPANY_PAN = "AACCG2320A";
const opts = (section: string, o: { override?: string | null; pan?: string } = {}) =>
  ({ section, pan: o.pan ?? COMPANY_PAN, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false, override: o.override });

describe("R-2320 planTds — a COGS bill takes services TDS like an expense bill", () => {
  it("example 1: Google ₹1,18,000 at 194C → 2% of ₹1,00,000 = ₹2,000; cash due ₹1,16,000", () => {
    const g = cogs({});
    const [t] = planTds([g], opts("194C"));
    expect(t).toMatchObject({ tds: 2000, section: "194C", fixed: false });
    expect(cashDue(g, t.tds)).toBe(116000);
  });
  it("the ₹1,16,000 bank line pre-ticks the bill net of TDS", () => {
    const g = cogs({});
    const pre = preselect([g], 116000, (bills) => tdsMap(planTds(bills, opts("194C"))));
    expect(pre).toEqual({ keys: [itemKey(g)], noTds: false });
  });
  it("cash + TDS reach the server as the gross settled — the bill is left with nothing due", () => {
    const g = cogs({});
    const args = payArgs({
      transactionId: "t", vendorId: "v", newVendor: null,
      items: [{ item: g, cash: 116000, tds: 2000, section: "194C" }],
      newBill: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
    });
    expect(args.p_items).toEqual([{ source: "vendor_bill", doc_id: "G1", amount: 118000, tds_amount: 2000, tds_section: "194C" }]);
  });
  it("a part-paid COGS bill takes no TDS (it goes with the first payment)", () => {
    const [t] = planTds([cogs({ amount_due: 60000 })], opts("194C"));
    expect(t.tds).toBe(0);
  });
  it("194Q stays the database's own figure — no 194Q from the services rule", () => {
    const [t] = planTds([cogs({})], opts("194Q"));
    expect(t.tds).toBe(0);
  });
  it("a new COGS bill typed here takes 194C; 194Q on it is refused with the way forward", () => {
    expect(newBillTds(100000, opts("194C"), "cogs")).toMatchObject({ tds: 2000, section: "194C" });
    const q = newBillTds(100000, opts("194Q"), "cogs");
    expect(q.tds).toBe(0);
    expect(q.reason).toMatch(/record it on the Bills page first/);
  });
});

describe("R-2320 owner override below the threshold", () => {
  it("example 3: Pankaj CA ₹16,200 at 194J is 'within the limit' — offered to override, no TDS yet", () => {
    const [t] = planTds([exp({})], opts("194J", { pan: "ABCPK2320A" }));
    expect(t.tds).toBe(0);
    expect(t.belowThreshold).toBe(true);
    expect(t.reason).toMatch(/within the limit/);
  });
  it("with the owner's reason → 10% = ₹1,620 at the section's rate; cash ₹14,580; reason sent to the server", () => {
    const p = exp({});
    const [t] = planTds([p], opts("194J", { pan: "ABCPK2320A", override: "Deducted in Zoho, CA said so" }));
    expect(t).toMatchObject({ tds: 1620, section: "194J", override: "Deducted in Zoho, CA said so" });
    expect(t.reason).toMatch(/Owner override/);
    expect(cashDue(p, t.tds)).toBe(14580);
    const args = payArgs({
      transactionId: "t", vendorId: "v", newVendor: null,
      items: [{ item: p, cash: 14580, tds: t.tds, section: t.section, override: t.override }],
      newBill: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
    });
    expect(args.p_items[0]).toEqual({ source: "expense", doc_id: "P1", amount: 16200, tds_amount: 1620, tds_section: "194J",
      tds_override_reason: "Deducted in Zoho, CA said so" });
  });
  it("a reason shorter than 5 letters does not override", () => {
    const [t] = planTds([exp({})], opts("194J", { pan: "ABCPK2320A", override: "ok" }));
    expect(t.tds).toBe(0);
  });
  it("above the threshold there is nothing to override (the reason is ignored)", () => {
    const [t] = planTds([cogs({})], opts("194C", { override: "Deducted in Zoho" }));
    expect(t).toMatchObject({ tds: 2000, belowThreshold: false, override: null });
  });
  it("new bill: override at the section's rate, individual 194C at 1%", () => {
    const r = newBillTds(20000, opts("194C", { pan: "ABCPR2320A", override: "Zoho deducted 1%" }), "cogs");
    expect(r).toMatchObject({ tds: 200, section: "194C", belowThreshold: true, override: "Zoho deducted 1%" });
    expect(newBillTds(20000, opts("194C", { pan: "ABCPR2320A" }), "cogs")).toMatchObject({ tds: 0, belowThreshold: true });
  });
  it("the override rate is the same rule tdsDecision uses (thresholds and rates unchanged)", () => {
    expect(tdsRatePct("194J", "ABCPK2320A")).toBe(10);
    expect(tdsRatePct("194C", "ABCPR2320A")).toBe(1);
    expect(tdsRatePct("194C", null)).toBe(20);
    expect(tdsRatePct("XYZ", "ABCPK2320A")).toBeNull();
    expect(overrideTds(16200, "194J", "ABCPK2320A")).toBe(1620);
    const d = tdsDecision({ section: "194J", base: 60000, fyBaseSoFar: 0, fyBaseWithoutTds: 0, pan: "ABCPK2320A" });
    expect(d).toMatchObject({ applies: true, ratePct: 10, tds: 6000 });
  });
  it("the new bill's override reason reaches the server only with TDS", () => {
    const base = { kind: "cogs" as const, billNo: "G-2", billDate: "2026-10-09", category: "COGS-Workspace", taxable: 20000, gst: 3600, itc: true, pay: 23600 };
    const withTds = payArgs({ transactionId: "t", vendorId: "v", newVendor: null, items: [],
      newBill: { ...base, tds: 400, tdsSection: "194C", tdsOverride: "Zoho deducted 2%" }, advance: 0, advanceCategory: null, bankCharge: 0, note: null });
    expect(withTds.p_new_bill).toMatchObject({ tds_amount: 400, tds_section: "194C", tds_override_reason: "Zoho deducted 2%" });
    const noTds = payArgs({ transactionId: "t", vendorId: "v", newVendor: null, items: [],
      newBill: { ...base, tds: 0, tdsSection: null, tdsOverride: "Zoho deducted 2%" }, advance: 0, advanceCategory: null, bankCharge: 0, note: null });
    expect(noTds.p_new_bill).not.toHaveProperty("tds_override_reason");
  });
});
