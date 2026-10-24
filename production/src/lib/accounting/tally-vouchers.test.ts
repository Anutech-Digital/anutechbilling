import { describe, it, expect } from "vitest";
import {
  tallyVouchersXml, salesEntries, salesFromInvoices, receiptsFromPayments, paymentsFromBills,
  DEFAULT_TALLY_LEDGERS, type TallySale, type TallyMoneyMove,
} from "./tally-vouchers";

const SALES: TallySale[] = [
  // intra-state, odd tax so CGST/SGST split has a remainder
  { date: "2026-09-10", number: "INV-ADPL-2026-27-0002", party: "R&D Solutions", taxable: 1001, tax: 181, interState: false, total: 1182 },
  // inter-state, total rounded up by ₹1
  { date: "2026-09-05", number: "INV-ADPL-2026-27-0001", party: "Mumbai Media", taxable: 10000, tax: 1800, interState: true, total: 11801 },
];
const RECEIPTS: TallyMoneyMove[] = [
  { date: "2026-09-12", number: "RV-ADPL-2026-27-0001", party: "R&D Solutions", amount: 1182, narration: "RV-ADPL-2026-27-0001 · upi" },
];
const PAYMENTS: TallyMoneyMove[] = [
  { date: "2026-09-15", number: "GW/9981", party: "Google India", amount: 24293, narration: "Bill GW/9981" },
];

const xml = tallyVouchersXml({ company: "ANUTECH DIGITAL PVT LTD", sales: SALES, receipts: RECEIPTS, payments: PAYMENTS });

const vouchers = (s: string) => [...s.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
const amounts = (v: string) => [...v.matchAll(/<AMOUNT>(-?\d+)<\/AMOUNT>/g)].map((m) => Number(m[1]));

describe("tallyVouchersXml", () => {
  it("every voucher balances to zero", () => {
    const vs = vouchers(xml);
    expect(vs).toHaveLength(4);
    for (const v of vs) expect(amounts(v).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("intra-state splits CGST/SGST exactly like GSTR-1 and the invoice (odd rupee into CGST, lib/gst/tax-split.ts)", () => {
    const e = salesEntries(SALES[0], DEFAULT_TALLY_LEDGERS);
    expect(e.find((x) => x.ledger === "Output CGST")?.amount).toBe(91);
    expect(e.find((x) => x.ledger === "Output SGST")?.amount).toBe(90);
    expect(e.find((x) => x.ledger === "Output IGST")?.amount).toBe(0);
  });

  it("puts a rupee rounding gap on Round Off instead of an unbalanced voucher", () => {
    const e = salesEntries(SALES[1], DEFAULT_TALLY_LEDGERS);
    expect(e.find((x) => x.ledger === "Round Off")?.amount).toBe(1);
  });

  it("escapes party names and honours custom ledger names", () => {
    expect(xml).toContain("<LEDGERNAME>R&amp;D Solutions</LEDGERNAME>");
    const custom = tallyVouchersXml({ company: "X", sales: [], receipts: RECEIPTS, payments: [], ledgers: { bank: "HDFC Bank A/c 1234" } });
    expect(custom).toContain("<LEDGERNAME>HDFC Bank A/c 1234</LEDGERNAME>");
  });

  it("snapshot of a small voucher set", () => {
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <ENVELOPE>
        <HEADER>
          <TALLYREQUEST>Import Data</TALLYREQUEST>
        </HEADER>
        <BODY>
          <IMPORTDATA>
            <REQUESTDESC>
              <REPORTNAME>Vouchers</REPORTNAME>
              <STATICVARIABLES>
                <SVCURRENTCOMPANY>ANUTECH DIGITAL PVT LTD</SVCURRENTCOMPANY>
              </STATICVARIABLES>
            </REQUESTDESC>
            <REQUESTDATA>
            <VOUCHER VCHTYPE="Sales" ACTION="Create">
              <DATE>20260905</DATE>
              <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
              <VOUCHERNUMBER>INV-ADPL-2026-27-0001</VOUCHERNUMBER>
              <PARTYLEDGERNAME>Mumbai Media</PARTYLEDGERNAME>
              <NARRATION>INV-ADPL-2026-27-0001</NARRATION>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Mumbai Media</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-11801</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Sales</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>10000</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Output IGST</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>1800</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Round Off</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>1</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
            </VOUCHER>
            <VOUCHER VCHTYPE="Sales" ACTION="Create">
              <DATE>20260910</DATE>
              <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
              <VOUCHERNUMBER>INV-ADPL-2026-27-0002</VOUCHERNUMBER>
              <PARTYLEDGERNAME>R&amp;D Solutions</PARTYLEDGERNAME>
              <NARRATION>INV-ADPL-2026-27-0002</NARRATION>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>R&amp;D Solutions</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-1182</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Sales</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>1001</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Output CGST</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>91</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Output SGST</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>90</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
            </VOUCHER>
            <VOUCHER VCHTYPE="Receipt" ACTION="Create">
              <DATE>20260912</DATE>
              <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
              <VOUCHERNUMBER>RV-ADPL-2026-27-0001</VOUCHERNUMBER>
              <PARTYLEDGERNAME>R&amp;D Solutions</PARTYLEDGERNAME>
              <NARRATION>RV-ADPL-2026-27-0001 · upi</NARRATION>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Bank</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-1182</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>R&amp;D Solutions</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>1182</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
            </VOUCHER>
            <VOUCHER VCHTYPE="Payment" ACTION="Create">
              <DATE>20260915</DATE>
              <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
              <VOUCHERNUMBER>GW/9981</VOUCHERNUMBER>
              <PARTYLEDGERNAME>Google India</PARTYLEDGERNAME>
              <NARRATION>Bill GW/9981</NARRATION>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Google India</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-24293</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
              <ALLLEDGERENTRIES.LIST>
                <LEDGERNAME>Bank</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>24293</AMOUNT>
              </ALLLEDGERENTRIES.LIST>
            </VOUCHER>
            </REQUESTDATA>
          </IMPORTDATA>
        </BODY>
      </ENVELOPE>"
    `);
  });
});

describe("row mapping", () => {
  it("invoices: void/draft/out-of-period dropped, no-GST-breakdown reported not guessed", () => {
    const r = salesFromInvoices([
      { id: "A", customer_name: "X", invoice_date: "2026-09-01", status: "paid", amount: 118, taxable_value: 100, tax_amount: 18, inter_state: false },
      { id: "B", customer_name: "X", invoice_date: "2026-09-02", status: "void", amount: 118, taxable_value: 100, tax_amount: 18, inter_state: false },
      { id: "C", customer_name: "X", invoice_date: "2026-08-31", status: "paid", amount: 118, taxable_value: 100, tax_amount: 18, inter_state: false },
      { id: "D", customer_name: "X", invoice_date: "2026-09-03", status: "pending", amount: 118, taxable_value: null, tax_amount: null, inter_state: null },
    ], "2026-09-01", "2026-09-30");
    expect(r.sales.map((s) => s.number)).toEqual(["A"]);
    expect(r.skipped).toEqual([{ id: "D", reason: expect.stringContaining("GST breakdown") }]);
  });
  it("receipts need a customer; payments are paid bills in the period", () => {
    const rec = receiptsFromPayments([
      { id: "p1", receipt_voucher_no: "RV-1", customer_id: "c1", amount: 500, received_at: "2026-09-04T10:00:00Z", method: "upi", reference: null },
      { id: "p2", receipt_voucher_no: null, customer_id: null, amount: 500, received_at: "2026-09-04T10:00:00Z", method: "cash", reference: null },
    ], new Map([["c1", "Asha Traders"]]), "2026-09-01", "2026-09-30");
    expect(rec.receipts).toEqual([expect.objectContaining({ number: "RV-1", party: "Asha Traders", amount: 500 })]);
    expect(rec.skipped.map((s) => s.id)).toEqual(["p2"]);

    // 00:30 IST on 1 Oct is 30 Sep in UTC — it belongs to October's day book, not September's
    const late = { id: "p3", receipt_voucher_no: "RV-3", customer_id: "c1", amount: 1, received_at: "2026-09-30T19:00:00Z", method: null, reference: null };
    expect(receiptsFromPayments([late], new Map([["c1", "A"]]), "2026-09-01", "2026-09-30").receipts).toHaveLength(0);
    expect(receiptsFromPayments([late], new Map([["c1", "A"]]), "2026-10-01", "2026-10-31").receipts[0].date).toBe("2026-10-01");

    // R-1565: advance credit applied is not bank money — Receipt at the cash part, none when all credit
    const credit = receiptsFromPayments([
      { id: "p4", receipt_voucher_no: "RV-4", customer_id: "c1", amount: 6000, credit_applied: 4000, received_at: "2026-09-05T10:00:00Z", method: "upi", reference: null },
      { id: "p5", receipt_voucher_no: "RV-5", customer_id: "c1", amount: 3000, credit_applied: 3000, received_at: "2026-09-06T10:00:00Z", method: "other", reference: null },
    ], new Map([["c1", "Asha Traders"]]), "2026-09-01", "2026-09-30");
    expect(credit.receipts).toEqual([expect.objectContaining({ number: "RV-4", amount: 2000 })]);

    const pay = paymentsFromBills([
      { id: "e1", vendor_name: "Google India", bill_no: "G1", amount: 1180, paid: true, paid_date: "2026-09-20", payment_method: "neft", category: "Licences" },
      { id: "e2", vendor_name: "Google India", bill_no: "G2", amount: 1180, paid: false, paid_date: null, payment_method: null, category: null },
    ], "2026-09-01", "2026-09-30");
    expect(pay.payments).toEqual([expect.objectContaining({ number: "G1", party: "Google India", amount: 1180 })]);
  });
});
