import { describe, it, expect } from "vitest";
import { matchCreditToInvoices, certainInvoiceMatches, tdsRateFor, referencesDocument, type OpenInvoice, type ChipTxn } from "./invoice-credit-match";
import { invoiceAmountDue } from "@/lib/payments/amount-due";

const inv = (o: Partial<OpenInvoice> & { id: string }): OpenInvoice => ({
  quoteId: `Q-${o.id}`, customerName: "Mukul Bhardwaj", invoiceDate: "2026-09-20",
  amountDue: 11800, taxableValue: 10000, ...o,
});
const credit = (amount: number, description: string, reference: string | null = null) =>
  ({ amount, txnDate: "2026-10-01", description, reference });

describe("matchCreditToInvoices (R-109)", () => {
  it("name + exact amount = certain and one-click", () => {
    const [m] = matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB"), [inv({ id: "INV-2026-0001" })]);
    expect(m.confidence).toBe("certain");
    expect(m.exactAmount).toBe(true);
    expect(m.oneClick).toBe(true);
    expect(m.blockedReason).toBeNull();
    expect(m.score).toBeGreaterThanOrEqual(55);
  });

  it("invoice number in the narration wins over a name-less amount match", () => {
    const out = matchCreditToInvoices(
      credit(11800, "NEFT-UTR519009330625-PAYMENT INV/2026/0002"),
      [inv({ id: "INV-2026-0001", customerName: "Darshan Kumar" }), inv({ id: "INV-2026-0002", customerName: "Darshan Kumar" })],
    );
    expect(out[0].invoiceId).toBe("INV-2026-0002");
    expect(out[0].confidence).toBe("certain");
    expect(out[0].oneClick).toBe(true);
    // The other one has the same amount and nothing to tell it apart → not one-click.
    expect(out[1].confidence).toBe("possible");
    expect(out[1].oneClick).toBe(false);
  });

  it("two same-amount invoices with no name/ref: neither is one-click", () => {
    const out = matchCreditToInvoices(
      credit(11800, "IMPS-519009330625-XXXXXXX10"),
      [inv({ id: "INV-A-000001", customerName: "Alpha" }), inv({ id: "INV-B-000002", customerName: "Beta" })],
    );
    expect(out).toHaveLength(2);
    expect(out.every((m) => !m.oneClick && m.confidence === "possible")).toBe(true);
  });

  it("single exact amount, no name: likely, one-click (operator still clicks)", () => {
    const [m] = matchCreditToInvoices(credit(11800, "IMPS-519009330625"), [inv({ id: "INV-2026-0001", customerName: "Someone Else" })]);
    expect(m.confidence).toBe("likely");
    expect(m.oneClick).toBe(true);
  });

  it("TDS-short credit is flagged and never one-click", () => {
    // ₹11,800 due on ₹10,000 taxable; 2% TDS = ₹200 → ₹11,600 arrives.
    const [m] = matchCreditToInvoices(credit(11600, "NEFT-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001" })]);
    expect(m.tdsRatePct).toBe(2);
    expect(m.shortBy).toBe(200);
    expect(m.confidence).toBe("certain");
    expect(m.oneClick).toBe(false);
    expect(m.blockedReason).toMatch(/TDS/);
  });

  it("10% TDS with unknown taxable value uses the 18% GST base", () => {
    expect(tdsRateFor(10800, 11800, null)).toBe(10);
    expect(tdsRateFor(11800, 11800, 10000)).toBeNull();
    expect(tdsRateFor(9000, 11800, 10000)).toBeNull();
  });

  it("name hit with a different amount is possible and blocked", () => {
    const [m] = matchCreditToInvoices(credit(5000, "UPI-MUKUL BHARDWAJ-98960"), [inv({ id: "INV-2026-0001" })]);
    expect(m.confidence).toBe("possible");
    expect(m.oneClick).toBe(false);
    expect(m.blockedReason).toMatch(/short of due/);
  });

  it("nothing in common → no candidate", () => {
    expect(matchCreditToInvoices(credit(777, "UPI-RANDOM PERSON"), [inv({ id: "INV-2026-0001" })])).toEqual([]);
  });

  it("paid / fully-received invoices never appear (due from invoiceAmountDue)", () => {
    const due = invoiceAmountDue({ amount: 11800, net_payable: 11800, paid_amount: 0, status: "paid" });
    expect(matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001", amountDue: due })])).toEqual([]);
  });

  it("partly-paid invoice matches on the REMAINING due, not the total", () => {
    const due = invoiceAmountDue({ amount: 11800, net_payable: 11800, paid_amount: 5000, status: "partially_paid" });
    const [m] = matchCreditToInvoices(credit(6800, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001", amountDue: due })]);
    expect(m.exactAmount).toBe(true);
    expect(m.oneClick).toBe(true);
  });

  it("project invoices and invoices without a quote are never one-click", () => {
    const out = matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ"), [
      inv({ id: "INV-P-000001", isProject: true }),
    ]);
    expect(out[0].oneClick).toBe(false);
    expect(out[0].blockedReason).toMatch(/project/i);
    const [noQ] = matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-N-000001", quoteId: null })]);
    expect(noQ.oneClick).toBe(false);
  });

  it("an invoice raised after the money (beyond a week) or over a year old is ignored", () => {
    expect(matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001", invoiceDate: "2026-10-20" })])).toEqual([]);
    expect(matchCreditToInvoices(credit(11800, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001", invoiceDate: "2025-09-01" })])).toEqual([]);
  });

  it("overpayment is blocked with the excess shown", () => {
    const [m] = matchCreditToInvoices(credit(12000, "UPI-MUKUL BHARDWAJ"), [inv({ id: "INV-2026-0001" })]);
    expect(m.overBy).toBe(200);
    expect(m.oneClick).toBe(false);
    expect(m.blockedReason).toMatch(/more than due/);
  });

  it("referencesDocument ignores separators but needs the whole id", () => {
    expect(referencesDocument({ description: "pay inv-et-2026-27-0013", reference: null }, "INV-ET-2026-27-0013")).toBe(true);
    expect(referencesDocument({ description: null, reference: "INVET2026270013" }, "INV-ET-2026-27-0013")).toBe(true);
    expect(referencesDocument({ description: "0013", reference: null }, "0013")).toBe(false);
  });

  it("zero / negative credit returns nothing", () => {
    expect(matchCreditToInvoices(credit(0, "x"), [inv({ id: "INV-2026-0001" })])).toEqual([]);
  });
});

describe("certainInvoiceMatches — the 'Matches INV-…' chip on the bank list (R-399)", () => {
  const txn = (o: Partial<ChipTxn> & { id: string }): ChipTxn => ({
    credit: 11800, txn_date: "2026-10-01", description: "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB",
    reference: null, matched_to_type: null, ...o,
  });

  it("an unmatched credit with a certain top match gets that invoice", () => {
    const m = certainInvoiceMatches([txn({ id: "t1" })], [inv({ id: "INV-2026-0001" })]);
    expect(m.get("t1")?.invoiceId).toBe("INV-2026-0001");
    expect(m.get("t1")?.confidence).toBe("certain");
  });

  it("no chip for a likely/possible top match (amount only, nobody named)", () => {
    const m = certainInvoiceMatches([txn({ id: "t1", description: "NEFT-UTR519009330625" })], [inv({ id: "INV-2026-0001" })]);
    expect(m.has("t1")).toBe(false);
  });

  it("no chip for debits or lines already reconciled", () => {
    const m = certainInvoiceMatches(
      [txn({ id: "d1", credit: 0 }), txn({ id: "r1", matched_to_type: "payment" })],
      [inv({ id: "INV-2026-0001" })],
    );
    expect(m.size).toBe(0);
  });

  it("two certain candidates (same customer, same amount) → no chip; the drawer lets the operator choose", () => {
    const m = certainInvoiceMatches([txn({ id: "t1" })], [inv({ id: "INV-2026-0001" }), inv({ id: "INV-2026-0002" })]);
    expect(matchCreditToInvoices(
      { amount: 11800, txnDate: "2026-10-01", description: "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB", reference: null },
      [inv({ id: "INV-2026-0001" }), inv({ id: "INV-2026-0002" })],
    ).filter((x) => x.confidence === "certain")).toHaveLength(2);
    expect(m.has("t1")).toBe(false);
  });

  it("no open invoices → no chips, and no matching work", () => {
    expect(certainInvoiceMatches([txn({ id: "t1" })], []).size).toBe(0);
  });
});
