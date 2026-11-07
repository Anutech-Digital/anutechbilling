/**
 * R-2565 — FY receipts import: a Razorpay payment Zoho recorded with bank charges (Razorpay's fee +
 * GST, taken before it settles) is importable — the receipt is the FULL amount on the invoice, the fee
 * is shown apart (booked as Razorpay's Bank Charges expense by the SQL). Any other bank charge is
 * still booked by hand. Shapes as Zoho v3 sends them; names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { OLD_BANK_CHARGES_PROBLEM, feeGstOf, feeRupees, isRazorpayPayment, zohoReceiptFacts, type ZohoReceiptFacts } from "./normalise";
import { SETTLEMENT_WAIT_REASON, buildReceiptsPlan, toReceiptPick, type ReceiptsPlanContext } from "./plan";

function detail(raw: Record<string, unknown>): ZohoFyDocDetail {
  return {
    kind: "customerpayments", id: String(raw.payment_id ?? "p1"), number: String(raw.payment_number ?? "101"), date: String(raw.date ?? "2025-06-10"),
    status: "", contactId: "zc1", contactName: "Test Buyer", totalPaise: 0, balancePaise: null, currency: "INR", raw,
    lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
  };
}

/* ₹11,800 invoice paid by card through Razorpay: Razorpay kept ₹278.48 (2% fee ₹236 + 18% GST ₹42.48). */
const rzp = {
  payment_id: "p1", payment_number: "RZP-1", date: "2025-06-10", payment_mode: "Razorpay", reference_number: "pay_TEST000000001",
  account_id: "zrzp", account_name: "Razorpay Clearing", currency_code: "INR", amount: 11800, unused_amount: 0, bank_charges: 278.48,
  invoices: [{ invoice_id: "zi1", invoice_number: "INV/25-26/0001", amount_applied: 11800 }],
};

describe("R-2565 normalise — Razorpay's fee is a fact, not a refusal", () => {
  it("receipt = the full amount applied to the invoice; fee (GST inside) shown apart; method razorpay", () => {
    const f = zohoReceiptFacts(detail(rzp));
    expect(f.problems).toEqual([]);
    expect(f).toMatchObject({ amount: 11800, receivedPaise: 1180000, excess: 0, tds: 0, fee: 278, feeGst: 42, method: "razorpay" });
    expect(f.lines).toEqual([{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 11800, tds: 0 }]);
  });

  it("a payment with no bank charges is unchanged (no fee, same method as before)", () => {
    const f = zohoReceiptFacts(detail({ ...rzp, bank_charges: 0, payment_mode: "Bank Transfer" }));
    expect(f).toMatchObject({ fee: 0, feeGst: 0, method: "bank_transfer", problems: [] });
  });

  it("Razorpay recognised by the deposit account too (Zoho mode 'Credit Card' into Razorpay Clearing)", () => {
    expect(zohoReceiptFacts(detail({ ...rzp, payment_mode: "Credit Card" }))).toMatchObject({ fee: 278, problems: [], method: "razorpay" });
    expect(isRazorpayPayment("UPI", "RazorPay Clearing")).toBe(true);
    expect(isRazorpayPayment("Bank Transfer", "HDFC 4523")).toBe(false);
  });

  it("still refused: a bank charge on a non-Razorpay payment, a fee not below the money, a negative fee", () => {
    const p = (extra: Record<string, unknown>) => zohoReceiptFacts(detail({ ...rzp, ...extra })).problems.join(" | ");
    expect(p({ payment_mode: "Bank Transfer", account_name: "HDFC Current 4523" })).toMatch(/not a Razorpay payment — book it by hand/);
    expect(p({ bank_charges: 11800 })).toMatch(/not less than the money received/);
    expect(p({ bank_charges: -5 })).toMatch(/negative bank charges/);
  });

  it("fee GST = 18% inside the fee, whole rupees", () => {
    expect(feeGstOf(278)).toBe(42);
    expect(feeGstOf(118)).toBe(18);
    expect(feeGstOf(0)).toBe(0);
  });
});

function facts(id: string, extra: Partial<ZohoReceiptFacts> = {}): ZohoReceiptFacts {
  return {
    zohoId: id, number: id, date: "2025-06-10", status: "", zohoCustomerId: "zc1", customerName: "Test Buyer", method: "razorpay",
    zohoMode: "Razorpay", reference: `pay_${id}`, depositAccountId: "zrzp", depositAccountName: "Razorpay Clearing",
    amount: 11800, receivedPaise: 1180000, lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 11800, tds: 0 }],
    excess: 0, tds: 0, fee: 278, feeGst: 42, viaSettlement: true, problems: [], ...extra,
  };
}
function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [
      { id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 11800 },
      { id: "INV/25-26/0002", zohoInvoiceId: "zi2", externalNumber: "INV/25-26/0002", documentKind: "tax_invoice", customerId: "c1", due: 5000 },
    ],
    bankAccounts: [{ id: "b4523", name: "Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true }],
    booked: new Map(), accountMap: { zrzp: "b4523" }, ...extra,
  };
}

describe("R-2565 plan — Check first counts fee payments as importable, fee apart", () => {
  it("a fee payment is 'import' at the full amount; the fee is counted apart; picks carry no money", () => {
    const p = buildReceiptsPlan([
      facts("p1"),
      facts("p2", { fee: 0, feeGst: 0, amount: 5000, receivedPaise: 500000, lines: [{ zohoInvoiceId: "zi2", invoiceNumber: "INV/25-26/0002", settle: 5000, tds: 0 }] }),
    ], ctx());
    expect(p.rows.map((r) => r.verdict)).toEqual(["import", "import"]);
    expect(p.counts).toMatchObject({ import: 2, withFee: 1, skip: 0 });
    expect(p.totals).toEqual({ cash: 16800, tds: 0, excess: 0, fee: 278 });   // cash = full receipts; fee not taken off
    expect(toReceiptPick(p.rows[0])).toEqual({ zoho_payment_id: "p1", bank_account_id: "b4523" });
  });

  it("a payment read before R-2565 (old 'book by hand' problem) asks for a new read, not a hand booking", () => {
    const p = buildReceiptsPlan([facts("p1", { fee: undefined as unknown as number, problems: [OLD_BANK_CHARGES_PROBLEM] })], ctx());
    expect(p.rows[0].verdict).toBe("skip");
    expect(p.rows[0].reason).toMatch(/^Read from Zoho again/);
    expect(p.totals.fee).toBe(0);
  });

  it("rerun: a booked fee payment waits for its Razorpay settlement — not counted as 'waiting for its bank line'", () => {
    const p = buildReceiptsPlan([facts("p1"), facts("p2")], ctx({ booked: new Map([["p1", { banked: false, viaSettlement: true }], ["p2", { banked: false, viaSettlement: false }]]) }));
    expect(p.rows.map((r) => [r.verdict, r.reason])).toEqual([["already", SETTLEMENT_WAIT_REASON], ["already", expect.stringMatching(/bank line is not matched yet/)]]);
    expect(p.counts).toMatchObject({ already: 2, alreadyNotBanked: 1, import: 0, withFee: 0 });
  });
});

describe("R-2565 review fixes", () => {
  it("fee rounded DOWN so the booked fees never exceed the settlement's (₹10.50 twice → ₹10 + ₹10, not ₹11 + ₹11)", () => {
    const f = zohoReceiptFacts(detail({ ...rzp, bank_charges: 10.5 }));
    expect(f.fee).toBe(10);
    expect(feeRupees(1099)).toBe(10);
    expect(feeRupees(0)).toBe(0);
  });

  it("a Razorpay payment with no fee (or under ₹1) still waits for its settlement — never matched alone", () => {
    expect(zohoReceiptFacts(detail({ ...rzp, bank_charges: 0 }))).toMatchObject({ fee: 0, viaSettlement: true });
    expect(zohoReceiptFacts(detail({ ...rzp, bank_charges: 0.4 }))).toMatchObject({ fee: 0, viaSettlement: true, problems: [] });
    expect(zohoReceiptFacts(detail({ ...rzp, bank_charges: 0, payment_mode: "Bank Transfer", account_name: "HDFC 4523" }))).toMatchObject({ viaSettlement: false });
  });

  it("an old non-Razorpay bank-charge payment keeps 'book it by hand' (no pointless re-read)", () => {
    const p = buildReceiptsPlan([facts("p1", { zohoMode: "Bank Transfer", depositAccountName: "HDFC 4523", problems: [OLD_BANK_CHARGES_PROBLEM] })], ctx({ accountMap: {} }));
    expect(p.rows[0].reason).toMatch(/not a Razorpay payment — book it by hand/);
  });
});
