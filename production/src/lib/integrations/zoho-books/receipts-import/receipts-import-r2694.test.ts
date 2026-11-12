/**
 * R-2694 (R-2693 part 2, p0 money) — a USD / foreign Zoho FY payment is imported (₹ at each invoice's
 * own rate, exchange gain / loss and the remitting bank's charges at Zoho's rate — booked by
 * import_zoho_fy_receipts, tested in supabase/tests/r2694_zoho_fy_foreign_receipts.test.sql). The
 * normaliser keeps Zoho's foreign figures TO THE CENT per invoice (foreignLines), the charges and the
 * unused money; the bank line it looks for is (money − charges) × Zoho's rate. Zoho v3 detail shapes;
 * names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoReceiptFacts, type ZohoReceiptFacts } from "./normalise";
import { buildReceiptsPlan, type ReceiptsPlanContext, type AppBankAccount } from "./plan";

function detail(raw: Record<string, unknown>): ZohoFyDocDetail {
  return {
    kind: "customerpayments", id: String(raw.payment_id ?? "p1"), number: String(raw.payment_number ?? "101"), date: String(raw.date ?? "2025-06-10"),
    status: "", contactId: "zc1", contactName: "Overseas Buyer LLC", totalPaise: 0, balancePaise: null, currency: String(raw.currency_code ?? "INR"), raw,
    lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
  };
}

const usd = (over: Record<string, unknown> = {}) => ({
  payment_id: "pu1", payment_number: "201", date: "2025-12-02", payment_mode: "Bank Remittance", reference_number: "INW123",
  account_id: "za4523", account_name: "HDFC Current 4523", currency_code: "USD", exchange_rate: 88.2, bank_charges: 0,
  amount: 663.05, unused_amount: 0,
  invoices: [{ invoice_id: "ziu", invoice_number: "INV/25-26/1627", amount_applied: 663.05 }],
  ...over,
});

const acct = (id: string, last4: string): AppBankAccount =>
  ({ id, name: "Current", bank_name: "HDFC", account_number_last4: last4, account_type: "current", is_active: true });

function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [
      { id: "INV/25-26/1627", zohoInvoiceId: "ziu", externalNumber: "INV/25-26/1627", documentKind: "tax_invoice", customerId: "c-usd", due: 58300 },
      { id: "INV/25-26/1628", zohoInvoiceId: "ziv", externalNumber: "INV/25-26/1628", documentKind: "tax_invoice", customerId: "c-usd", due: 8300 },
    ],
    bankAccounts: [acct("b4523", "4523")],
    booked: new Map(), accountMap: {}, ...extra,
  };
}

describe("R-2694 normalise — a USD payment is importable, with its figures to the cent", () => {
  it("no 'not imported yet' problem; per-invoice USD to the cent; ₹ at Zoho's rate; bank line = USD × rate", () => {
    const f = zohoReceiptFacts(detail(usd()));
    expect(f.problems).toEqual([]);
    expect(f.foreignLines).toEqual([{ zohoInvoiceId: "ziu", invoiceNumber: "INV/25-26/1627", foreign: 663.05 }]);
    expect(f).toMatchObject({ currency: "USD", foreignAmount: 663.05, fxRate: 88.2, foreignCharges: 0, amount: 58481 });
    expect(f.receivedPaise).toBe(Math.round(66305 * 88.2));
  });

  it("two invoices keep their cents (never whole dollars)", () => {
    const f = zohoReceiptFacts(detail(usd({ amount: 200.5, invoices: [
      { invoice_id: "ziu", invoice_number: "INV/25-26/1627", amount_applied: 100.25 },
      { invoice_id: "ziv", invoice_number: "INV/25-26/1628", amount_applied: 100.25 }] })));
    expect(f.foreignLines!.map((l) => l.foreign)).toEqual([100.25, 100.25]);
  });

  it("Zoho bank charges on a USD payment: the remitting bank's (not a Razorpay fee); the bank line is net of them", () => {
    const f = zohoReceiptFacts(detail(usd({ amount: 100, bank_charges: 2, exchange_rate: 84,
      invoices: [{ invoice_id: "ziu", invoice_number: "INV/25-26/1627", amount_applied: 100 }] })));
    expect(f.problems).toEqual([]);
    expect(f).toMatchObject({ foreignCharges: 2, fee: 0, feeGst: 0, viaSettlement: false, method: "bank_transfer" });
    expect(f.receivedPaise).toBe(9800 * 84);   // USD 98 reached the bank = ₹8,232.00
  });

  it("refused with a reason: no rate; unused USD (an advance in USD); charges not below the money", () => {
    expect(zohoReceiptFacts(detail(usd({ exchange_rate: 0 }))).problems[0]).toMatch(/^Received in USD in Zoho with no exchange rate/);
    expect(zohoReceiptFacts(detail(usd({ amount: 673.05, unused_amount: 10 }))).problems[0]).toMatch(/^USD 10\.00 of it is not applied to any invoice in Zoho \(an advance in USD\)/);
    expect(zohoReceiptFacts(detail(usd({ bank_charges: 663.05 }))).problems[0]).toMatch(/bank charges on this USD payment are not less than the money/);
  });

  it("an INR payment carries no foreign fields (unchanged)", () => {
    const f = zohoReceiptFacts(detail({ payment_id: "pi", amount: 1000, currency_code: "INR", invoices: [{ invoice_id: "zi1", invoice_number: "I1", amount_applied: 1000 }] }));
    expect(f.foreignLines).toBeUndefined();
    expect(f.receivedPaise).toBe(100000);
  });
});

describe("R-2694 plan — a USD payment is 'to record'; one read before R-2694 asks for Read again", () => {
  it("new USD facts → import (SQL converts at the invoice's rate)", () => {
    const p = buildReceiptsPlan([zohoReceiptFacts(detail(usd()))], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", customerId: "c-usd", reason: null });
    expect(p.totals.cash).toBe(58481);
  });

  it("USD facts from R-2693 part 1 (no foreignLines) → left out: read it from Zoho again", () => {
    const f = zohoReceiptFacts(detail(usd()));
    const old: ZohoReceiptFacts = { ...f, foreignLines: undefined, foreignCharges: undefined,
      problems: ["Received in USD in Zoho — foreign-currency payments are not imported yet; book it from its bank line (Banking → the inward USD line → Reconcile, exchange gain / loss there)."] };
    const p = buildReceiptsPlan([old], ctx());
    expect(p.rows[0].verdict).toBe("skip");
    expect(p.rows[0].reason).toMatch(/^Read from Zoho again — a USD payment can be imported now/);
  });

  it("a USD line is never compared with the ₹ due as if its dollars were rupees", () => {
    /* USD 100 on an invoice with ₹8,300 due: 100 < 8,300 by coincidence either way — use one whose
       dollars exceed the ₹ due number to prove no ₹-vs-USD compare: USD 9,000 vs ₹8,300 due would
       be refused by a ₹ compare; the SQL decides with the invoice's rate. */
    const f = zohoReceiptFacts(detail(usd({ amount: 9000, invoices: [{ invoice_id: "ziv", invoice_number: "INV/25-26/1628", amount_applied: 9000 }] })));
    const p = buildReceiptsPlan([f], ctx());
    expect(p.rows[0].verdict).toBe("import");
  });
});
