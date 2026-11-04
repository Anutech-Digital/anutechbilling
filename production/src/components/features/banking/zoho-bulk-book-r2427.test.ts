/**
 * R-2427 — "Book selected" for an export receipt that pays a USD invoice already in the app
 * (reconcile_bank_credit_fx_invoice: receipt + forex / Bank Charges lines in one call), and for a
 * short remittance booked as a new sale (12-argument reconcile_bank_credit_new_sale_fx with
 * p_foreign_billed). All database calls are fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { bookRows, fxInvoiceArgs, newSaleFxArgs, type BookDeps } from "./zoho-bulk-book";
import { planAll, planRow, type PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const ctx: PlanContext = {
  customers: [{ id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States", domain: null }],
  subscriptions: [], catalog: [], payers: [], ownNames: [], today: "2026-11-03",
  lut: { number: "AD070426000123X", validUpto: "2027-03-31" },
};
const match = (amount: number, rate: number): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "p", number: "9001", date: "2026-08-07", amount, reference: "070826I049900001", customerZohoId: "z", customerName: "Design Box", currency: "USD", exchangeRate: rate },
  customer: { zohoId: "z", name: "Design Box", gstin: null },
  invoices: [{ zohoId: "i", number: "INV/26-27/0501", date: "2026-07-01", amountApplied: amount, total: amount, lines: [
    { invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: amount, itemTotal: null, start: null, end: null, months: 0, domain: null },
  ] }],
  moreInvoices: [],
});
const result: PayForResult = {
  kind: "one_off", quote_id: "Q-A", invoice_id: "INV-A", invoice_issued: null, payment_id: "pay", receipt_voucher_no: null, amount: 83000, tds_amount: 0,
  outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, subscriptions: [],
};
const deps = (over: Partial<BookDeps> = {}): BookDeps => ({
  isReconciled: vi.fn(async () => false),
  createCustomer: vi.fn(async () => "c-new"),
  setPayer: vi.fn(async () => undefined),
  newSale: vi.fn(async () => result),
  newSaleFx: vi.fn(async () => result),
  payFxInvoice: vi.fn(async () => result),
  saleSubscriptions: vi.fn(async () => []),
  setSubDates: vi.fn(async () => undefined),
  payItem: vi.fn(async () => result),
  payOpening: vi.fn(async () => ({ paymentId: "x", alreadyRecorded: false })),
  ...over,
});

const facts = {
  customerId: "c-dbox", openings: [], receipts: [], billed: [],
  openItems: [{ kind: "invoice", quoteId: "Q-A", invoiceId: "INV-A", docDate: "2026-07-01", due: 83000, taxable: 83000, makesSubscription: false, approvalBlock: null, currency: "USD", fxRate: 83 }],
};
const [payRow] = planAll([{
  line: { id: "t-a", txnDate: "2026-08-07", credit: 84500, description: "INW 070826I049900001 USD1000.0@84.5", reference: null },
  result: { kind: "match", match: match(1000, 84.5) }, contact: null, facts, booksStart: null,
}], ctx);

describe("R-2427 Book selected — export receipt on a USD invoice", () => {
  it("pays INV-A through reconcile_bank_credit_fx_invoice with the narration's figures; never the ₹ pay-item", async () => {
    expect(payRow.ticked).toBe(true);
    const d = deps();
    const run = await bookRows([payRow], new Set(["t-a"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.payItem).not.toHaveBeenCalled();
    expect(d.payFxInvoice).toHaveBeenCalledWith(expect.objectContaining({ p_txn_id: "t-a", p_invoice_id: "INV-A", p_currency: "USD", p_fx_rate: 84.5, p_foreign_amount: 1000 }));
    expect(run.done[0].text).toBe("Paid invoice INV-A in full in USD — forex gain ₹1,500 — line reconciled.");
  });

  it("stops with a plain reason when the screen cannot pay a USD invoice (nothing paid in ₹)", async () => {
    const d = deps({ payFxInvoice: undefined });
    const run = await bookRows([payRow], new Set(["t-a"]), new Set(), d);
    expect(d.payItem).not.toHaveBeenCalled();
    expect(d.setPayer).not.toHaveBeenCalled();
    expect(run.error?.reason).toContain("cannot pay an invoice in that currency");
  });

  it("fxInvoiceArgs: the 7 arguments of reconcile_bank_credit_fx_invoice, with the plan's subscription choice", () => {
    expect(Object.keys(fxInvoiceArgs("t", "INV-A", payRow.book!.item!.fx!)).sort()).toEqual(
      ["p_create_subscription", "p_currency", "p_foreign_amount", "p_fx_rate", "p_invoice_id", "p_sub_start", "p_txn_id"]);
    expect(fxInvoiceArgs("t", "INV-A", payRow.book!.item!.fx!, { createSubscription: false, subStart: "2026-07-01" }))
      .toMatchObject({ p_create_subscription: false, p_sub_start: null });
  });

  it("the booked text says what the SERVER booked (its bank_charges / forex_difference)", async () => {
    const d = deps({ payFxInvoice: vi.fn(async () => ({ ...result, bank_charges: 12, forex_difference: -1400 } as PayForResult)) });
    const run = await bookRows([payRow], new Set(["t-a"]), new Set(), d);
    expect(run.done[0].text).toBe("Paid invoice INV-A in full in USD — Bank Charges ₹12 — forex gain ₹1,400 — line reconciled.");
  });
});

describe("R-2427 Book selected — short remittance as a new sale", () => {
  const shortRow = planRow({ id: "t-s", txnDate: "2026-08-08", credit: 93600, description: "INW 080826I049900002 USD1000.0@93.6", reference: null }, match(1024, 93.6), null, ctx);
  it("sends p_foreign_billed (Zoho's $1,024) so the 12-argument function books the $24 as Bank Charges", async () => {
    expect(shortRow.ticked).toBe(true);
    const d = deps();
    await bookRows([shortRow], new Set(["t-s"]), new Set(), d);
    expect(d.newSaleFx).toHaveBeenCalledWith(expect.anything(), { currency: "USD", rate: 93.6, foreignAmount: 1000, billed: 1024 });
    const a = newSaleFxArgs({
      transactionId: "t-s", customerId: "c-dbox", lines: shortRow.book!.lines, createSubscription: false, subStart: null, subRenewal: null,
      tdsAmount: 0, tdsRatePct: null, tdsSection: null, billingCycle: null, externalNumber: null,
    }, shortRow.book!.fx!);
    expect(a).toMatchObject({ p_foreign_amount: 1000, p_foreign_billed: 1024, p_fx_rate: 93.6 });
  });
  it("no short → no p_foreign_billed (the R-2440 11-argument call, unchanged)", () => {
    const a = newSaleFxArgs({
      transactionId: "t", customerId: "c", lines: [], createSubscription: false, subStart: null, subRenewal: null,
      tdsAmount: 0, tdsRatePct: null, tdsSection: null, billingCycle: null, externalNumber: null,
    }, { currency: "USD", rate: 93.6, foreignAmount: 1024 });
    expect(a).not.toHaveProperty("p_foreign_billed");
  });
});
