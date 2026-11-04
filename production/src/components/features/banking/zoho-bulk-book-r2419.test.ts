/**
 * R-2419 — "Book selected" for the two new plan kinds: (e) a row that pays an open quote goes through
 * reconcile_bank_credit_to_item (payItem), never a new sale; (a) a row that settles last year's
 * opening invoice is a receipt on it (record_multi_invoice_payment) + the line matched to that
 * receipt (reconcile_bank_txn) — a retry replays the same receipt. All database calls are fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { bookRows, openingPaymentArgs, payOpeningInvoice, type BookDeps } from "./zoho-bulk-book";
import { planAll, type BulkMatchRow, type PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const ctx: PlanContext = {
  customers: [{ id: "c-sharp", name: "Sharp Coating", gstin: null, state_code: "07", country: "India", domain: "sharpcoat.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-03",
};
const zl = (over: Partial<ZohoMatchLine>): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/1", name: "Workspace", sku: null, qty: 1, rate: 2572, itemTotal: null,
  start: "2026-11-01", end: "2027-10-31", months: 12, domain: "sharpcoat.in", ...over,
});
function m(invoice: string, invoiceDate: string, amount: number): ZohoPaymentMatch {
  return {
    by: "utr", payment: { zohoId: "p", number: "1", date: null, amount, reference: "", customerZohoId: "z", customerName: "Sharp Coating" },
    customer: { zohoId: "z", name: "Sharp Coating", gstin: null },
    invoices: [{ zohoId: "i", number: invoice, date: invoiceDate, amountApplied: amount, total: amount, lines: [zl({})] }], moreInvoices: [],
  };
}
const row = (id: string, match: ZohoPaymentMatch, facts: BulkMatchRow["facts"], txnDate = "2026-10-28"): BulkMatchRow => ({
  line: { id, txnDate, credit: match.payment.amount, description: "NEFT CR-HDFC0000001-SHARP COATING-UTR1", reference: "UTR1" },
  result: { kind: "match", match }, contact: null, facts, booksStart: null,
});
const result = (over: Partial<PayForResult> = {}): PayForResult => ({
  kind: "renewal", quote_id: "Q-A378-27-0901", invoice_id: null, invoice_issued: "INV-9", payment_id: "pay", receipt_voucher_no: null, amount: 3035, tds_amount: 0,
  outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: true, subscription_skipped: false, already_recorded: false,
  subscriptions: [], ...over,
});
function deps(): BookDeps {
  return {
    isReconciled: vi.fn(async () => false),
    createCustomer: vi.fn(async () => "c-new"),
    setPayer: vi.fn(async () => {}),
    newSale: vi.fn(async () => result()),
    saleSubscriptions: vi.fn(async () => []),
    setSubDates: vi.fn(async () => {}),
    payItem: vi.fn(async () => result()),
    payOpening: vi.fn(async () => ({ paymentId: "pay-o", alreadyRecorded: false })),
  };
}
const facts = (over: Partial<NonNullable<BulkMatchRow["facts"]>> = {}) =>
  ({ customerId: "c-sharp", openItems: [], openings: [], receipts: [], billed: [], ...over });

describe("R-2419 Book selected: pay an open quote / settle an opening balance", () => {
  it("(e) Sharp Coating: pays Q-A378-27-0901 — no new sale", async () => {
    const item = { kind: "renewal", quoteId: "Q-A378-27-0901", invoiceId: null, docDate: "2026-10-20", due: 3035, taxable: 2572, makesSubscription: false, approvalBlock: null };
    const plan = planAll([row("t-s", m("INV/26-27/0901", "2026-10-20", 3035), facts({ openItems: [item] }))], ctx);
    const d = deps();
    const run = await bookRows(plan, new Set(["t-s"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.newSale).not.toHaveBeenCalled();
    expect(d.payItem).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "t-s", quoteId: "Q-A378-27-0901", invoiceId: null, createSubscription: null }));
    expect(run.done[0]).toMatchObject({ outcome: "booked", text: "Paid open quote Q-A378-27-0901 — line reconciled." });
  });

  it("(a) last year's invoice: a receipt on the opening invoice — no new sale", async () => {
    const plan = planAll([row("t-o", m("INV/25-26/0412", "2025-04-01", 3035), facts({ openings: [{ id: "OPN-7", number: "INV/25-26/0412", date: "2025-04-01", due: 3035 }] }), "2026-05-12")], ctx);
    const d = deps();
    const run = await bookRows(plan, new Set(["t-o"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.newSale).not.toHaveBeenCalled();
    expect(d.payOpening).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "t-o", customerId: "c-sharp", invoiceId: "OPN-7", received: 3035, receivedOn: "2026-05-12", reference: "UTR1" }));
    expect(run.done[0]).toMatchObject({ outcome: "booked", invoiceId: "OPN-7" });
  });

  it("payOpeningInvoice: records on the opening invoice, then matches the line to that receipt", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return fn === "record_multi_invoice_payment"
        ? { data: { idempotent_replay: false, lines: [{ invoice_id: "OPN-7", payment_id: "pay-77" }] }, error: null }
        : { data: {}, error: null };
    });
    const input = { transactionId: "t-o", customerId: "c-1", invoiceId: "OPN-7", received: 3035, receivedOn: "2026-05-12", reference: "UTR1", tdsAmount: 0, tdsRatePct: null, tdsSection: null };
    const out = await payOpeningInvoice(input, "acct-1", rpc);
    expect(out).toEqual({ paymentId: "pay-77", alreadyRecorded: false });
    expect(calls[0]).toEqual(["record_multi_invoice_payment", openingPaymentArgs(input, "acct-1")]);
    expect(calls[0][1]).toMatchObject({ p_received: 3035, p_excess_to_credit: false, p_allocations: [{ invoice_id: "OPN-7", amount: 3035, tds_amount: 0 }] });
    expect(calls[1]).toEqual(["reconcile_bank_txn", { p_txn_id: "t-o", p_matched_to_type: "payment", p_matched_to_id: "pay-77", p_match_confidence: "manual" }]);
  });

  it("payOpeningInvoice: the match failing says the receipt is kept and a retry reuses it", async () => {
    const rpc = vi.fn(async (fn: string) => fn === "record_multi_invoice_payment"
      ? { data: { idempotent_replay: true, lines: [{ payment_id: "pay-77" }] }, error: null }
      : { data: null, error: { message: "This bank line is already reconciled." } });
    const input = { transactionId: "t-o", customerId: "c-1", invoiceId: "OPN-7", received: 3035, receivedOn: "2026-05-12", reference: "UTR1", tdsAmount: 0, tdsRatePct: null, tdsSection: null };
    await expect(payOpeningInvoice(input, "acct-1", rpc)).rejects.toThrow(/never a second one/);
  });
});
