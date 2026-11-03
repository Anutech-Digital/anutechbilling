/**
 * R-2425 — "Book selected" for an export receipt: the sale goes through
 * reconcile_bank_credit_new_sale_fx (currency + the bank's rate, ₹ = the bank credit), never the INR
 * sale; an INR row is unchanged. All database calls are fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { bookRows, newSaleFxArgs, type BookDeps } from "./zoho-bulk-book";
import { planRow, type PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const ctx: PlanContext = {
  customers: [{ id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States", domain: null }],
  subscriptions: [], catalog: [], payers: [], ownNames: [], today: "2026-11-03",
};
const usdMatch: ZohoPaymentMatch = {
  by: "utr",
  payment: { zohoId: "p", number: "9001", date: "2026-08-07", amount: 1024, reference: "070826I049902623", customerZohoId: "z", customerName: "Design Box", currency: "USD", exchangeRate: 93.6 },
  customer: { zohoId: "z", name: "Design Box", gstin: null },
  invoices: [{ zohoId: "i", number: "INV/26-27/0501", date: "2026-08-01", amountApplied: 1024, total: 1024, lines: [
    { invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: 1024, itemTotal: null, start: null, end: null, months: 0, domain: null },
  ] }],
  moreInvoices: [],
};
const usdRow = planRow({ id: "t-usd", txnDate: "2026-08-07", credit: 95846, description: "INW 070826I049902623 USD1024.0@93.6", reference: null }, usdMatch, null, ctx);

const result: PayForResult = {
  kind: "new", quote_id: "Q-1", invoice_id: "INV-1", invoice_issued: "INV-1", payment_id: "pay", receipt_voucher_no: null, amount: 95846, tds_amount: 0,
  outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, subscriptions: [],
};
const deps = (over: Partial<BookDeps> = {}): BookDeps => ({
  isReconciled: vi.fn(async () => false),
  createCustomer: vi.fn(async () => "c-new"),
  setPayer: vi.fn(async () => undefined),
  newSale: vi.fn(async () => result),
  newSaleFx: vi.fn(async () => result),
  saleSubscriptions: vi.fn(async () => []),
  setSubDates: vi.fn(async () => undefined),
  payItem: vi.fn(async () => result),
  payOpening: vi.fn(async () => ({ paymentId: "x", alreadyRecorded: false })),
  ...over,
});

describe("R-2425 Book selected — export receipt", () => {
  it("books through the foreign-currency sale with the bank's rate; never the INR sale", async () => {
    expect(usdRow.ticked).toBe(true);
    const d = deps();
    const run = await bookRows([usdRow], new Set(["t-usd"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.newSale).not.toHaveBeenCalled();
    expect(d.newSaleFx).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "t-usd", customerId: "c-dbox", externalNumber: "INV/26-27/0501", tdsAmount: 0 }),
      { currency: "USD", rate: 93.6, foreignAmount: 1024 },
    );
    expect(run.done[0].text).toBe("Booked in USD at the bank's rate (₹93.6) and reconciled.");
  });

  it("stops with a plain reason when the screen has no foreign-currency sale (nothing booked as INR)", async () => {
    const d = deps({ newSaleFx: undefined });
    const run = await bookRows([usdRow], new Set(["t-usd"]), new Set(), d);
    expect(d.newSale).not.toHaveBeenCalled();
    expect(d.createCustomer).not.toHaveBeenCalled();
    expect(d.setPayer).not.toHaveBeenCalled();
    expect(run.error?.reason).toContain("export receipt in USD");
  });

  it("newSaleFxArgs: the 11 arguments of reconcile_bank_credit_new_sale_fx — no TDS, Zoho number kept", () => {
    const a = newSaleFxArgs({
      transactionId: "t", customerId: "c", lines: usdRow.book!.lines, createSubscription: false, subStart: null, subRenewal: null,
      tdsAmount: 0, tdsRatePct: null, tdsSection: null, billingCycle: null, externalNumber: " INV/26-27/0501 ",
    }, { currency: "USD", rate: 93.6, foreignAmount: 1024 });
    expect(Object.keys(a).sort()).toEqual([
      "p_billing_cycle", "p_create_subscription", "p_currency", "p_customer_id", "p_external_number", "p_foreign_amount",
      "p_fx_rate", "p_lines", "p_sub_renewal", "p_sub_start", "p_txn_id",
    ]);
    expect(a).toMatchObject({ p_txn_id: "t", p_currency: "USD", p_fx_rate: 93.6, p_foreign_amount: 1024, p_external_number: "INV/26-27/0501", p_sub_start: null });
    expect((a.p_lines as Array<{ rate: number }>)[0].rate).toBe(95846.4);
  });
});
