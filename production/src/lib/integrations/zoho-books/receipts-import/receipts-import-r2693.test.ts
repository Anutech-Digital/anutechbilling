/**
 * R-2693 (p0, G-FY2526) — no scanned Zoho FY payment is left out silently. Staging 12 Nov: 482 scanned
 * customer payments were never imported and the database says why for only 4; every USD / overseas
 * customer was among them. Part 1: every scanned payment ends in ONE bucket (import / already / left
 * out) and every left-out one carries a plain reason; a foreign-currency payment says its currency,
 * its own amount and the rupees at Zoho's rate (never its dollars shown as rupees).
 * Zoho v3 detail shapes; names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoReceiptFacts, foreignOf, type ZohoReceiptFacts } from "./normalise";
import { buildReceiptsPlan, skipReasonKey, type ReceiptsPlanContext, type AppBankAccount } from "./plan";

function detail(raw: Record<string, unknown>): ZohoFyDocDetail {
  return {
    kind: "customerpayments", id: String(raw.payment_id ?? "p1"), number: String(raw.payment_number ?? "101"), date: String(raw.date ?? "2025-06-10"),
    status: "", contactId: "zc1", contactName: "Overseas Buyer LLC", totalPaise: 0, balancePaise: null, currency: String(raw.currency_code ?? "INR"), raw,
    lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
  };
}

const usd = {
  payment_id: "pu1", payment_number: "201", date: "2025-12-02", payment_mode: "Bank Remittance", reference_number: "INW123",
  account_id: "za4523", account_name: "HDFC Current 4523", currency_code: "USD", exchange_rate: 88.2, bank_charges: 0,
  amount: 663.05, unused_amount: 0, invoices: [{ invoice_id: "ziu", invoice_number: "INV/25-26/1627", amount_applied: 663.05 }],
};

const acct = (id: string, last4: string): AppBankAccount =>
  ({ id, name: "Current", bank_name: "HDFC", account_number_last4: last4, account_type: "current", is_active: true });

function facts(id: string, extra: Partial<ZohoReceiptFacts> = {}): ZohoReceiptFacts {
  return {
    zohoId: id, number: id, date: "2025-06-10", status: "", zohoCustomerId: "zc1", customerName: "Test Buyer", method: "bank_transfer",
    zohoMode: "Bank Transfer", reference: `UTR-${id}`, depositAccountId: "za4523", depositAccountName: "HDFC Current 4523",
    amount: 1000, receivedPaise: 100000, lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1000, tds: 0 }],
    excess: 0, tds: 0, fee: 0, feeGst: 0, viaSettlement: false, problems: [], ...extra,
  };
}

function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [
      { id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 50000 },
      /* an overseas customer (no GSTIN — receipts never look at it) */
      { id: "INV/25-26/0005", zohoInvoiceId: "zi5", externalNumber: "INV/25-26/0005", documentKind: "tax_invoice", customerId: "c-overseas", due: 21000 },
      { id: "INV/25-26/1627", zohoInvoiceId: "ziu", externalNumber: "INV/25-26/1627", documentKind: "tax_invoice", customerId: "c-usd", due: 58300 },
    ],
    bankAccounts: [acct("b4523", "4523")],
    booked: new Map(), accountMap: {}, ...extra,
  };
}

describe("R-2693 normalise — a foreign-currency payment says what it is", () => {
  it("USD: currency, its own amount and Zoho's rate kept; ₹ = amount × Zoho's rate (never the dollars as rupees)", () => {
    const f = zohoReceiptFacts(detail(usd));
    expect(f).toMatchObject({ currency: "USD", foreignAmount: 663.05, fxRate: 88.2, amount: 58481 });
    expect(f.problems).toEqual([]);   // R-2694: a USD payment with a rate is imported now
    expect(foreignOf(f)).toEqual({ currency: "USD", amount: 663.05, inr: 58481 });
  });

  it("USD with no exchange rate in Zoho: still listed, says the rate is missing, no ₹ guessed", () => {
    const f = zohoReceiptFacts(detail({ ...usd, exchange_rate: 0 }));
    expect(f.problems.join(" | ")).toMatch(/no exchange rate/);
    expect(foreignOf(f)).toEqual({ currency: "USD", amount: 663.05, inr: null });
  });

  it("a payment read before R-2693 (no currency field, dollars stored as `amount`): shown as USD, not ₹", () => {
    const old = facts("old", { amount: 663, problems: ["Received in USD in Zoho — book a foreign-currency receipt by hand."] });
    expect(foreignOf(old)).toEqual({ currency: "USD", amount: 663, inr: null });
  });

  it("INR: no foreign figures", () => {
    const f = zohoReceiptFacts(detail({ ...usd, currency_code: "INR", exchange_rate: 1, amount: 1000, invoices: [{ invoice_id: "zi1", invoice_number: "A", amount_applied: 1000 }] }));
    expect(f.problems).toEqual([]);
    expect(foreignOf(f)).toBeNull();
    expect(f.amount).toBe(1000);
  });
});

describe("R-2693 plan — every scanned payment accounted for, each left-out one with a reason", () => {
  it("INR payment imports; overseas customer with NO GSTIN imports (never refused for that); USD and missing-invoice ones are left out WITH a reason (R-2694: USD with a rate now imports)", () => {
    const usdFacts = zohoReceiptFacts(detail(usd));
    const all = [
      facts("inr"),
      facts("overseas", { customerName: "Overseas Buyer LLC", lines: [{ zohoInvoiceId: "zi5", invoiceNumber: "INV/25-26/0005", settle: 21000, tds: 0 }], amount: 21000, receivedPaise: 2100000 }),
      usdFacts,
      facts("noinv", { lines: [{ zohoInvoiceId: "zgone", invoiceNumber: "INV/25-26/1552", settle: 1000, tds: 0 }] }),
    ];
    const p = buildReceiptsPlan(all, ctx());
    const by = Object.fromEntries(p.rows.map((r) => [r.facts.zohoId, r]));
    expect(by.inr).toMatchObject({ verdict: "import", customerId: "c1" });
    expect(by.overseas).toMatchObject({ verdict: "import", customerId: "c-overseas" });
    expect(by.pu1).toMatchObject({ verdict: "import", customerId: "c-usd" });   // R-2694: imported now
    expect(by.noinv.verdict).toBe("skip");
    expect(by.noinv.reason).toMatch(/INV\/25-26\/1552 is not an FY sale imported from Zoho here/);
    /* nothing disappears: the buckets add up to what was scanned, every left-out one has a reason */
    expect(p.counts.import + p.counts.already + p.counts.skip).toBe(p.counts.scanned);
    expect(p.rows.filter((r) => r.verdict === "skip").every((r) => (r.reason ?? "").trim().length > 0)).toBe(true);
    expect(p.skipReasons.reduce((s, r) => s + r.count, 0)).toBe(p.counts.skip);
  });

  it("the deposit account's ₹ total counts a USD payment at Zoho's rate, never its dollars as rupees", () => {
    const p = buildReceiptsPlan([facts("inr"), zohoReceiptFacts(detail(usd))], ctx());
    expect(p.deposits[0]).toMatchObject({ zohoAccountId: "za4523", count: 2, amount: 1000 + 58481 });
  });

  it("skip reasons group by kind: two USD payments of different amounts are ONE reason with count 2 (R-2694: both read before they could be imported)", () => {
    const a = { ...zohoReceiptFacts(detail(usd)), foreignLines: undefined };
    const b = { ...zohoReceiptFacts(detail({ ...usd, payment_id: "pu2", amount: 1416.65, invoices: [{ invoice_id: "ziu", invoice_number: "INV/25-26/2274", amount_applied: 1416.65 }] })), foreignLines: undefined };
    const p = buildReceiptsPlan([a, b], ctx());
    expect(p.skipReasons).toEqual([{ reason: skipReasonKey(p.rows[0].reason!), count: 2 }]);
  });
});

describe("R-2693 review fixes", () => {
  it("an old USD payment whose currency problem is NOT first is still shown as USD (never its dollars as ₹)", () => {
    const old = facts("old2", { amount: 663, problems: ["A negative amount is applied to an invoice in Zoho — book it by hand.", "Received in USD in Zoho — book a foreign-currency receipt by hand."] });
    expect(foreignOf(old)).toEqual({ currency: "USD", amount: 663, inr: null });
  });

  it("a deposit account with a foreign payment whose ₹ is not known counts it apart, never as ₹0 inside the total", () => {
    const old = facts("old", { amount: 663, problems: ["Received in USD in Zoho — book a foreign-currency receipt by hand."] });
    const p = buildReceiptsPlan([facts("inr"), old], ctx());
    expect(p.deposits[0]).toMatchObject({ count: 2, amount: 1000, amountUnknown: 1 });
  });

  it("reasons with an ISO date or a Razorpay id group as one kind", () => {
    expect(skipReasonKey("Dated 2025-03-31, outside the year.")).toBe(skipReasonKey("Dated 2024-12-01, outside the year."));
    expect(skipReasonKey("Razorpay payment pay_ABC123 is already in the app")).toBe(skipReasonKey("Razorpay payment pay_Zx9 is already in the app"));
  });
});
