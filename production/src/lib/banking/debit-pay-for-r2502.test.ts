// R-2502c — a COGS bill imported from Zoho carries Zoho's TDS (vendor_bills.zoho_tds_amount /
// _section); Reconcile's open item pre-fills it on the bill's first payment
// (bank_debit_vendor_open_items). The screen must take that TDS as FIXED — exactly what Zoho
// deducted, like an expense bill's own TDS — not work out another figure or none.
import { describe, it, expect } from "vitest";
import { planTds, preselect, tdsMap, itemKey, cashDue, type VendorOpenItem } from "./debit-pay-for";
import { suggestMoneyOut } from "./reconcile-suggestion";

const cogs = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "vendor_bill", doc_id: "Z1", bill_no: "C-1", doc_date: "2025-05-12", due_date: null, category: "COGS-Workspace",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 200, tds_section: "194C", can_part: true, in_run: null, ...o,
});
const opts = (section: string | null) => ({ section, pan: "AACCG2502A", fyOthers: { base: 0, baseWithoutTds: 0 }, off: false });

describe("R-2502c — a COGS bill's Zoho TDS is fixed in Reconcile", () => {
  it("planTds takes the bill's own TDS whatever section the vendor has (or none)", () => {
    for (const sec of [null, "194C", "194JB"]) {
      const [t] = planTds([cogs({})], opts(sec));
      expect(t).toMatchObject({ tds: 200, section: "194C", fixed: true });
    }
  });
  it("the ₹11,600 bank line (Zoho's net payment) pre-ticks the bill net of that TDS — nothing stays due", () => {
    const g = cogs({});
    const pre = preselect([g], 11600, (bills) => tdsMap(planTds(bills, opts(null))));
    expect(pre.keys).toEqual([itemKey(g)]);
    expect(pre.noTds).toBe(false);
    expect(cashDue(g, 200)).toBe(11600);
  });
  it("the one-tap suggestion carries the TDS too", () => {
    const s = suggestMoneyOut({ debit: 11600, vendor: { id: "v", name: "Mehta", default_tds_section: null }, guessReason: "the only open bill", items: [cogs({})] });
    expect(s).toMatchObject({ cash: 11600, tds: 200, tdsSection: "194C" });
  });
});
