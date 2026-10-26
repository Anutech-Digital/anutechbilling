// R-1866 — the money-out "This payment is for:" sheet's pure part. Owner examples first:
//   1. ₹11,800 to Google for bill G-1 (₹11,800)          → G-1 ticked, paid in full
//   2. ₹64,800 to Sharma for PS-101 (₹59,000) + PS-102    → both ticked, 194J 10% on ₹60,000 = ₹6,000
//      (₹11,800), net of TDS
//   3. ₹10,000 to Google on G-2 (₹23,600)                 → part payment, ₹13,600 stays due
//   4. ₹15,000 with nothing billed                        → advance
import { describe, it, expect } from "vitest";
import {
  allocateOldestFirst, guessVendor, itemKey, newBillTds, payArgs, planTds, preselect, resultLines, summarise,
  tdsMap, vendorPan, type Bill194q, type VendorOpenItem, type VendorPayResult,
} from "./debit-pay-for";

const exp = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "expense", doc_id: "E1", bill_no: "PS-101", doc_date: "2026-09-01", due_date: null, category: "Professional Services",
  total: 59000, amount_due: 59000, gst: 9000, tds_base: 50000, tds_amount: 0, tds_section: null, can_part: false, in_run: null, ...o,
});
const cogs = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "vendor_bill", doc_id: "B1", bill_no: "G-1", doc_date: "2026-09-05", due_date: "2026-10-05", category: "COGS-Workspace",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: true, in_run: null, ...o,
});
const E1 = exp({});
const E2 = exp({ doc_id: "E2", bill_no: "PS-102", doc_date: "2026-09-15", total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000 });
const B1 = cogs({});
const B2 = cogs({ doc_id: "B2", bill_no: "G-2", doc_date: "2026-09-20", total: 23600, amount_due: 23600, gst: 3600, tds_base: 20000 });
const PAN = "AAKFS1866A";
const j = (section: string | null, fyOthers: { base: number; baseWithoutTds: number } | null = { base: 0, baseWithoutTds: 0 }) =>
  ({ section, pan: PAN, fyOthers, off: false });

describe("guessVendor — only an unambiguous payee", () => {
  const vendors = [
    { id: "v1", name: "Sharma Associates", upi_id: "sharma@okhdfcbank", bank_account_no: "50100123456789" },
    { id: "v2", name: "Google Cloud India" },
    { id: "v3", name: "Sharma Traders" },
  ];
  it("UPI id in the narration wins", () => {
    expect(guessVendor({ description: "UPI/sharma@okhdfcbank/fees" }, vendors)?.vendorId).toBe("v1");
  });
  it("account number in the narration", () => {
    expect(guessVendor({ description: "NEFT TO A/C 50100123456789 FEES" }, vendors)?.vendorId).toBe("v1");
  });
  it("a name word shared with one vendor", () => {
    expect(guessVendor({ description: "NEFT GOOGLE CLOUD G-1" }, vendors)).toMatchObject({ vendorId: "v2" });
  });
  it("two vendors share the word → no guess", () => {
    expect(guessVendor({ description: "IMPS SHARMA" }, vendors)).toBeNull();
  });
  it("the vendor sharing more words wins (Kapoor Legal Associates over Kapoor Stationers)", () => {
    const vs = [{ id: "k1", name: "Kapoor Stationers" }, { id: "k2", name: "Kapoor Legal Associates" }];
    expect(guessVendor({ description: "NEFT-KAPOOR LEGAL ASSOCIATES-KL201 KL202" }, vs))
      .toEqual({ vendorId: "k2", reason: "the bank line says “kapoor legal associates”" });
  });
});

describe("planTds — the app's TDS rule on the bills paid together", () => {
  it("example 2: PS-101 + PS-102 at 194J → ₹60,000 crosses ₹50,000 → 10% = 5,000 + 1,000", () => {
    const t = planTds([E1, E2], j("194J"));
    expect(t.map((x) => x.tds)).toEqual([5000, 1000]);
    expect(t[0].section).toBe("194J");
    expect(t[0].reason).toMatch(/194J/);
  });
  it("one ₹40,000 bill alone stays under the 194J year limit → no TDS", () => {
    const t = planTds([exp({ tds_base: 40000, amount_due: 47200 })], j("194J"));
    expect(t[0].tds).toBe(0);
    expect(t[0].reason).toMatch(/within the limit/);
  });
  it("the vendor's earlier payments this year count toward the limit", () => {
    expect(planTds([exp({ tds_base: 40000, amount_due: 47200 })], j("194J", { base: 20000, baseWithoutTds: 0 }))[0].tds).toBe(4000);
  });
  it("a bill that already carries TDS keeps it; a COGS bill takes none", () => {
    const t = planTds([exp({ tds_amount: 5000, tds_section: "194J" }), B1], j("194C"));
    expect(t[0]).toMatchObject({ tds: 5000, section: "194J", fixed: true });
    expect(t[1].tds).toBe(0);
  });
  it("no section / 'no TDS' → nothing", () => {
    expect(planTds([E1, E2], j(null)).every((x) => x.tds === 0)).toBe(true);
    expect(planTds([E1, E2], { ...j("194J"), off: true }).every((x) => x.tds === 0)).toBe(true);
  });
  it("a new bill uses the same rule", () => {
    expect(newBillTds(60000, j("194J")).tds).toBe(6000);
    expect(newBillTds(60000, { ...j("194J"), off: true }).tds).toBe(0);
  });
  it("PAN from the GSTIN when the vendor has none", () => {
    expect(vendorPan({ pan: null, gstin: "07AAKFS1866A1Z5" })).toBe("AAKFS1866A");
  });
});

describe("planTds — R-1891 194Q on a COGS bill: the database's figure, only for a ₹10 crore buyer", () => {
  const q = (o: Partial<Bill194q> = {}): Bill194q => ({
    doc_id: "B2", fy_start: "2026-04-01", fy_before: 4000000, base: 1000000, rate_pct: 0.1, no_pan: false,
    tds_total: 1000, tds_already: 0, tds_due: 1000, buyer: true, ...o,
  });
  const big = cogs({ doc_id: "B2", bill_no: "IM-2", total: 2360000, amount_due: 2360000, gst: 360000, tds_base: 2000000 });
  const with194q = (rows: Bill194q[]) => ({ ...j("194Q"), q194: new Map(rows.map((r) => [r.doc_id, r])) });

  it("section 194Q + buyer yes → the bill's TDS due, with the why", () => {
    const [t] = planTds([big], with194q([q()]));
    expect(t).toMatchObject({ tds: 1000, section: "194Q", fixed: true });
    expect(t.reason).toBe("194Q: bought ₹40,00,000 from this vendor this year before this bill — 0.1% on ₹10,00,000 above ₹50 lakh = ₹1,000.");
  });
  it("seller without PAN → says 5%", () => {
    const [t] = planTds([big], with194q([q({ rate_pct: 5, no_pan: true, tds_total: 50000, tds_due: 50000 })]));
    expect(t.tds).toBe(50000);
    expect(t.reason).toContain("5% (no PAN)");
  });
  it("turnover not answered or 'no' → no TDS on the goods bill", () => {
    expect(planTds([big], with194q([q({ buyer: null })]))[0].tds).toBe(0);
    expect(planTds([big], with194q([q({ buyer: false })]))[0].tds).toBe(0);
  });
  it("another section, 'No TDS', or nothing due → none", () => {
    expect(planTds([big], { ...with194q([q()]), section: "194C" })[0].tds).toBe(0);
    expect(planTds([big], { ...with194q([q()]), off: true })[0].tds).toBe(0);
    expect(planTds([big], with194q([q({ base: 0, tds_total: 0, tds_due: 0 })]))[0].tds).toBe(0);
  });
  it("the exact bank amount after 194Q is pre-ticked", () => {
    const pre = preselect([big], 2359000, (bills) => tdsMap(planTds(bills, with194q([q()]))));
    expect(pre.keys).toEqual([itemKey(big)]);
  });
  it("the TDS reaches the server with the gross settled", () => {
    const args = payArgs({
      transactionId: "t", vendorId: "v", newVendor: null,
      items: [{ item: big, cash: 2359000, tds: 1000, section: "194Q" }],
      newBill: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
    });
    expect(args.p_items).toEqual([{ source: "vendor_bill", doc_id: "B2", amount: 2360000, tds_amount: 1000, tds_section: "194Q" }]);
  });
});

describe("allocateOldestFirst", () => {
  it("example 2: ₹64,800 over PS-101 + PS-102 net of TDS → both fully paid, nothing left", () => {
    const tds = tdsMap(planTds([E1, E2], j("194J")));
    const a = allocateOldestFirst([E2, E1], 64800, tds);
    expect(a.cashByKey.get(itemKey(E1))).toBe(54000);
    expect(a.cashByKey.get(itemKey(E2))).toBe(10800);
    expect(a.left).toBe(0);
  });
  it("example 3: ₹10,000 on G-2 → part payment", () => {
    const a = allocateOldestFirst([B2], 10000, new Map());
    expect(a.cashByKey.get(itemKey(B2))).toBe(10000);
    expect(a.left).toBe(0);
  });
  it("oldest COGS bill first, the rest goes to the next; extra is left over (→ advance)", () => {
    const a = allocateOldestFirst([B2, B1], 40000, new Map());
    expect(a.cashByKey.get(itemKey(B1))).toBe(11800);
    expect(a.cashByKey.get(itemKey(B2))).toBe(23600);
    expect(a.left).toBe(4600);
  });
  it("an expense bill is never part-paid: not enough → 0 for it", () => {
    const a = allocateOldestFirst([E1], 30000, new Map());
    expect(a.cashByKey.get(itemKey(E1))).toBe(0);
    expect(a.left).toBe(30000);
  });
});

describe("preselect", () => {
  const plan = (bills: readonly VendorOpenItem[]) => tdsMap(planTds(bills, j("194J")));
  it("example 1: the one bill whose due equals the debit", () => {
    expect(preselect([B1, B2], 11800, plan)).toEqual({ keys: [itemKey(B1)], noTds: false });
  });
  it("example 2: all bills when together, after TDS, they make the debit", () => {
    expect(preselect([E1, E2], 64800, plan)).toEqual({ keys: [itemKey(E1), itemKey(E2)], noTds: false });
  });
  it("paid gross (no TDS) → ticked with 'no TDS'", () => {
    expect(preselect([E1, E2], 70800, plan)).toEqual({ keys: [itemKey(E1), itemKey(E2)], noTds: true });
  });
  it("two bills of the same amount → none; a bill in a payment run is never ticked", () => {
    expect(preselect([B1, cogs({ doc_id: "B9" })], 11800, plan).keys).toEqual([]);
    expect(preselect([cogs({ in_run: "PR-202610-001" })], 11800, plan).keys).toEqual([]);
  });
});

describe("summarise + payArgs", () => {
  it("parts must make the bank amount", () => {
    expect(summarise(13625, { bills: 13600, newBill: 0, advance: 0, charge: 25 }).diff).toBe(0);
    expect(summarise(9999, { bills: 0, newBill: 0, advance: 5000, charge: 0 }).diff).toBe(4999);
  });
  it("sends gross settled = cash + TDS, the section only with TDS, nothing for a 0-cash row", () => {
    const args = payArgs({
      transactionId: "t1", vendorId: "v1", newVendor: { name: "ignored", gstin: null, pan: null, tdsSection: null },
      items: [
        { item: E1, cash: 54000, tds: 5000, section: "194J" },
        { item: B1, cash: 0, tds: 0, section: null },
      ],
      newBill: null, advance: 0, advanceCategory: "Advertising", bankCharge: 25, note: null,
    });
    expect(args.p_new_vendor).toBeNull();
    expect(args.p_items).toEqual([{ source: "expense", doc_id: "E1", amount: 59000, tds_amount: 5000, tds_section: "194J" }]);
    expect(args.p_advance_category).toBeNull();
    expect(args.p_bank_charge).toBe(25);
  });
  it("example 4: a new vendor + advance", () => {
    const args = payArgs({
      transactionId: "t5", vendorId: null, newVendor: { name: " Meta Ads India ", gstin: "", pan: "aagcm1866c", tdsSection: null },
      items: [], newBill: null, advance: 15000, advanceCategory: "Advertising", bankCharge: 0, note: null,
    });
    expect(args.p_new_vendor).toEqual({
      name: "Meta Ads India", gstin: null, pan: "AAGCM1866C", tds_section: null, bank_account_no: null, bank_ifsc: null, upi_id: null,
    });
    expect(args.p_advance).toBe(15000);
    expect(args.p_advance_category).toBe("Advertising");
  });
  it("R-1918: a new vendor from the bank line carries its account no, IFSC and UPI id to the server", () => {
    const args = payArgs({
      transactionId: "t6", vendorId: null,
      newVendor: { name: "Sharma Associates", gstin: null, pan: null, tdsSection: "194J", accountNo: "5010 0123 4567 89", ifsc: " hdfc0001234 ", upi: " Sharma@OkHdfcBank " },
      items: [], newBill: null, advance: 5000, advanceCategory: "Other", bankCharge: 0, note: null,
    });
    expect(args.p_new_vendor).toEqual({
      name: "Sharma Associates", gstin: null, pan: null, tds_section: "194J",
      bank_account_no: "50100123456789", bank_ifsc: "HDFC0001234", upi_id: "sharma@okhdfcbank",
    });
  });
  it("R-1918: an IFSC without the account number is not sent (they go together — R-1905)", () => {
    const args = payArgs({
      transactionId: "t7", vendorId: null,
      newVendor: { name: "Sharma Associates", gstin: null, pan: null, tdsSection: null, accountNo: "", ifsc: "HDFC0001234", upi: "" },
      items: [], newBill: null, advance: 5000, advanceCategory: "Other", bankCharge: 0, note: null,
    });
    expect(args.p_new_vendor).toMatchObject({ bank_account_no: null, bank_ifsc: null, upi_id: null });
  });
  it("a new expense bill with GST input and TDS", () => {
    const args = payArgs({
      transactionId: "t4", vendorId: "v1", newVendor: null, items: [],
      newBill: { kind: "expense", billNo: "PS-130", billDate: "2026-10-12", category: "Professional Services", taxable: 20000, gst: 3600, itc: true, pay: 23600, tds: 2000, tdsSection: "194J" },
      advance: 0, advanceCategory: null, bankCharge: 0, note: null,
    });
    expect(args.p_new_bill).toEqual({ kind: "expense", bill_no: "PS-130", bill_date: "2026-10-12", category: "Professional Services", taxable: 20000, gst: 3600, itc: true, tds_amount: 2000, tds_section: "194J", pay: 23600 });
  });
});

describe("resultLines — what happened, in the owner's words", () => {
  const r: VendorPayResult = {
    vendor_id: "v1", vendor_name: "Sharma Associates", vendor_created: false, bank_amount: 64800,
    paid: [
      { source: "expense", doc_id: "E1", bill_no: "PS-101", settled: 59000, cash: 54000, tds: 5000, tds_section: "194J", status: "paid", still_due: 0 },
      { source: "vendor_bill", doc_id: "B2", bill_no: "G-2", settled: 10000, cash: 10000, tds: 0, tds_section: null, status: "partial", still_due: 13600 },
    ],
    new_bill: null, advance: { id: "a1", amount: 4600, category: "Professional Services" }, bank_charge: { expense_id: "X", amount: 25 },
    tds_total: 5000, tds_section: "194J",
  };
  const lines = resultLines(r);
  it("names the bill, amount, vendor, TDS and the new status, with a link", () => {
    expect(lines[0].text).toBe("Paid Bill #PS-101 (₹59,000) to Sharma Associates · TDS ₹5,000 deducted (194J) · Bill now Paid");
    expect(lines[0].href).toBe("/accounting/expenses?edit=E1");
    expect(lines[1].text).toBe("Paid Bill #G-2 (₹10,000) to Sharma Associates · Bill now part paid, ₹13,600 still due");
  });
  it("advance, bank charge and TDS payable each say where they went", () => {
    expect(lines.some((l) => l.text.includes("₹4,600 kept as an advance") && l.href === "/accounting/prepaid")).toBe(true);
    expect(lines.some((l) => l.text.includes("Bank charge ₹25"))).toBe(true);
    expect(lines.some((l) => l.text.includes("TDS ₹5,000 (194J) withheld"))).toBe(true);
  });
});
