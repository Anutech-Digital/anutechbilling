/**
 * R-2501 — FY 2025-26 Zoho customer payments → receipts (+ TDS) on the imported Zoho invoices.
 * Zoho v3 detail shapes (money in rupees as Zoho sends it); names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoReceiptFacts, appMethod, type ZohoReceiptFacts } from "./normalise";
import { buildReceiptsPlan, suggestAccount, toReceiptPick, type ReceiptsPlanContext, type AppBankAccount } from "./plan";

function detail(raw: Record<string, unknown>): ZohoFyDocDetail {
  return {
    kind: "customerpayments", id: String(raw.payment_id ?? "p1"), number: String(raw.payment_number ?? "101"), date: String(raw.date ?? "2025-06-10"),
    status: "", contactId: "zc1", contactName: "Test Buyer", totalPaise: 0, balancePaise: null, currency: "INR", raw,
    lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
  };
}

const base = {
  payment_id: "p1", payment_number: "101", date: "2025-06-10", payment_mode: "Bank Transfer", reference_number: "UTR123",
  account_id: "za4523", account_name: "HDFC Current 4523", currency_code: "INR", bank_charges: 0,
};

describe("R-2501 normalise — paise → rupees once; Zoho's own TDS only", () => {
  it("splits applied + TDS per invoice; cash = settle − TDS; excess = unused", () => {
    const f = zohoReceiptFacts(detail({
      ...base, amount: 10900.1, unused_amount: 1000, tax_amount_withheld: 246.9,
      invoices: [
        { invoice_id: "zi1", invoice_number: "INV/25-26/0001", amount_applied: 9900.1, tax_amount_withheld: 246.9 },
      ],
    }));
    expect(f.problems).toEqual([]);
    expect(f.lines).toEqual([{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 10147, tds: 247 }]);
    expect(f).toMatchObject({ amount: 10900, receivedPaise: 1090010, excess: 1000, tds: 247, method: "bank_transfer", reference: "UTR123", depositAccountId: "za4523" });
  });

  it("no TDS in Zoho → none booked (never inferred from a short payment)", () => {
    const f = zohoReceiptFacts(detail({ ...base, amount: 900, unused_amount: 0, invoices: [{ invoice_id: "zi1", invoice_number: "A", amount_applied: 900 }] }));
    expect(f.tds).toBe(0);
    expect(f.lines[0]).toMatchObject({ settle: 900, tds: 0 });
  });

  it("refuses payments whose amounts do not add up, foreign money, bank charges, unsplit TDS", () => {
    const p = (extra: Record<string, unknown>) => zohoReceiptFacts(detail({ ...base, amount: 1000, unused_amount: 0,
      invoices: [{ invoice_id: "zi1", invoice_number: "A", amount_applied: 1000 }], ...extra })).problems.join(" | ");
    expect(p({ unused_amount: 50 })).toMatch(/do not add up/);
    expect(p({ amount: 900 })).toMatch(/more to its invoices than the payment received/);
    expect(p({ currency_code: "USD" })).toMatch(/USD/);
    expect(p({ bank_charges: 10 })).toMatch(/bank charges/);
    expect(p({ tax_amount_withheld: 100 })).toMatch(/TDS is not split by invoice/);
    expect(p({ invoices: [{ invoice_id: "zi1", amount_applied: 500 }, { invoice_id: "zi1", amount_applied: 500 }] })).toMatch(/one invoice twice/);
  });

  it("maps Zoho's payment mode to the app's method", () => {
    expect(appMethod("Cash")).toBe("cash");
    expect(appMethod("Cheque")).toBe("cheque");
    expect(appMethod("UPI")).toBe("upi");
    expect(appMethod("Bank Remittance")).toBe("bank_transfer");
    expect(appMethod("Credit Card")).toBe("other");
  });
});

const acct = (id: string, name: string, last4: string | null, accountType = "current"): AppBankAccount => ({ id, name, bankName: "HDFC", last4, accountType, active: true });

function facts(id: string, extra: Partial<ZohoReceiptFacts> = {}): ZohoReceiptFacts {
  return {
    zohoId: id, number: id, date: "2025-06-10", status: "", zohoCustomerId: "zc1", customerName: "Test Buyer", method: "bank_transfer",
    zohoMode: "Bank Transfer", reference: `UTR-${id}`, depositAccountId: "za4523", depositAccountName: "HDFC Current 4523",
    amount: 1000, receivedPaise: 100000, lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1000, tds: 0 }],
    excess: 0, tds: 0, problems: [], ...extra,
  };
}

function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [
      { id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 1500 },
      { id: "INV/25-26/0002", zohoInvoiceId: "zi2", externalNumber: "INV/25-26/0002", documentKind: "tax_invoice", customerId: "c2", due: 500 },
      { id: "INV/24-25/0099", zohoInvoiceId: null, externalNumber: "INV/24-25/0099", documentKind: "opening_invoice", customerId: "c1", due: 700 },
    ],
    bankAccounts: [acct("b4523", "Current", "4523"), acct("bcash", "Petty cash", null, "cash")],
    booked: new Map(), accountMap: {}, ...extra,
  };
}

describe("R-2501 plan — receipts only onto imported Zoho sales", () => {
  it("books a payment onto its imported invoice, deposit account suggested by last 4 digits", () => {
    const p = buildReceiptsPlan([facts("p1")], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", customerId: "c1", bankAccountId: "b4523", invoiceIds: ["INV/25-26/0001"] });
    expect(p.deposits[0]).toMatchObject({ zohoAccountId: "za4523", appAccountId: "b4523", suggested: true });
    expect(toReceiptPick(p.rows[0])).toEqual({ zoho_payment_id: "p1", bank_account_id: "b4523" });
    expect(Object.keys(toReceiptPick(p.rows[0]))).not.toContain("amount");
  });

  it("an opening invoice or a not-imported invoice skips the WHOLE payment", () => {
    const p = buildReceiptsPlan([
      facts("p1", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 500, tds: 0 }, { zohoInvoiceId: "zx", invoiceNumber: "INV/24-25/0099", settle: 500, tds: 0 }] }),
      facts("p2", { lines: [{ zohoInvoiceId: "zmissing", invoiceNumber: "INV/25-26/0777", settle: 1000, tds: 0 }] }),
    ], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "skip" });
    expect(p.rows[0].reason).toMatch(/opening invoice/);
    expect(p.rows[1].reason).toMatch(/not an FY sale imported from Zoho/);
  });

  it("refuses: before books start, in the lock, no books start, pure advance, two customers, more than due, no account", () => {
    const r = (f: ZohoReceiptFacts, c: Partial<ReceiptsPlanContext> = {}) => buildReceiptsPlan([f], ctx(c)).rows[0].reason ?? "";
    expect(r(facts("a", { date: "2025-04-20" }), { booksStart: "2025-05-01" })).toMatch(/before the books start/);
    expect(r(facts("a"), { lockedUntil: "2025-06-30" })).toMatch(/books lock/);
    expect(r(facts("a"), { booksStart: null })).toMatch(/books start date is not set/);
    expect(r(facts("a", { lines: [] }))).toMatch(/advance/);
    expect(r(facts("a", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "1", settle: 100, tds: 0 }, { zohoInvoiceId: "zi2", invoiceNumber: "2", settle: 100, tds: 0 }] }))).toMatch(/different customers/);
    expect(r(facts("a", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1600, tds: 0 }] }))).toMatch(/only ₹1500 due/);
    expect(r(facts("a", { depositAccountId: "zx", depositAccountName: "Some Wallet" }))).toMatch(/Choose the app account/);
    expect(r(facts("a", { problems: ["Zoho took bank charges off this payment — book it by hand."] }))).toMatch(/bank charges/);
  });

  it("two payments on one invoice: the second sees what the first took", () => {
    const p = buildReceiptsPlan([facts("p1"), facts("p2", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1000, tds: 0 }] })], ctx());
    expect(p.rows.map((x) => x.verdict)).toEqual(["import", "skip"]);
    expect(p.rows[1].reason).toMatch(/only ₹500 due/);
  });

  it("rerun: an imported payment is 'already'; one with no bank line yet says so", () => {
    const p = buildReceiptsPlan([facts("p1"), facts("p2")], ctx({ booked: new Map([["p1", { banked: true }], ["p2", { banked: false }]]) }));
    expect(p.rows.map((x) => x.verdict)).toEqual(["already", "already"]);
    expect(p.counts).toMatchObject({ already: 2, alreadyNotBanked: 1, import: 0 });
  });

  it("the owner's account choice wins over the suggestion; another company's id is ignored", () => {
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "bcash" } })).rows[0].bankAccountId).toBe("bcash");
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "not-ours" } })).rows[0].bankAccountId).toBe("b4523");
  });

  it("suggests by last 4 digits, exact name, or the one cash account", () => {
    const list = [acct("b1", "Current", "4523"), acct("b2", "Savings", "9876"), acct("c", "Cash in hand", null, "cash")];
    expect(suggestAccount("HDFC Bank - 50200012344523", list)).toBe("b1");
    expect(suggestAccount("Petty Cash", list)).toBe("c");
    expect(suggestAccount("Undeposited Funds", list)).toBeNull();
  });
});
