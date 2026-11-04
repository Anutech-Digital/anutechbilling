/**
 * R-2474 — "Book selected" for last year's invoice that the app had no opening invoice for: the
 * opening invoice is made from Zoho's own invoice (import_opening_invoices, R-1739 — no GST, no
 * revenue; keyed by the Zoho number so a re-run never makes a second one), then paid with the bank
 * line through R-2466's opening path — one invoice: reconcile_bank_credit_to_item (payItem); several:
 * reconcile_bank_credit_split. All database calls are fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { bookRows, ensureOpeningInvoices, openingImportRows, type BookDeps } from "./zoho-bulk-book";
import { planAll, type BulkMatchRow, type OpeningCreate, type PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoInvoiceHistory, ZohoMatchInvoice, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const ctx: PlanContext = {
  customers: [{ id: "c-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3", state_code: "07", country: "India", domain: "acmetools.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-04",
};
const hist = (amount: number, over: Partial<ZohoInvoiceHistory> = {}): ZohoInvoiceHistory => ({
  dueDate: "2026-01-15", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
  payments: [{ paymentId: "zp-1", date: "2026-05-12", amount, tds: 0 }], credits: [], ...over,
});
const inv = (number: string, total: number, history: ZohoInvoiceHistory): ZohoMatchInvoice => ({
  zohoId: `zi-${number}`, number, date: "2025-12-01", amountApplied: total, total, history,
  lines: [{ invoiceNumber: number, name: "Workspace", sku: null, qty: 1, rate: total, itemTotal: null, start: null, end: null, months: null, domain: null }],
});
function match(invoices: ZohoMatchInvoice[], amount: number, customer = "Acme Tools"): ZohoPaymentMatch {
  return {
    by: "utr", payment: { zohoId: "zp-1", number: "PAY-1", date: "2026-05-12", amount, reference: "UTR77", customerZohoId: "z-1", customerName: customer },
    customer: { zohoId: "z-1", name: customer, gstin: customer === "Acme Tools" ? "07AAACT1234A1Z3" : null }, invoices, moreInvoices: [],
  };
}
const row = (id: string, m: ZohoPaymentMatch, credit: number): BulkMatchRow => ({
  line: { id, txnDate: "2026-05-12", credit, description: "NEFT CR-HDFC0000001-ACME TOOLS-UTR77", reference: "UTR77" },
  result: { kind: "match", match: m }, contact: null,
  facts: { customerId: "c-acme", openItems: [], openings: [], receipts: [], billed: [] }, booksStart: "2026-04-01",
});
const paid = (over: Partial<PayForResult> = {}): PayForResult => ({
  kind: "invoice", quote_id: null, invoice_id: "INV/25-26/0412", invoice_issued: null, payment_id: "pay-1", receipt_voucher_no: "RV-1", amount: 59000, tds_amount: 0,
  outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false,
  subscriptions: [], ...over,
});
function deps(over: Partial<BookDeps> = {}): BookDeps {
  return {
    isReconciled: vi.fn(async () => false),
    createCustomer: vi.fn(async () => "c-new"),
    setPayer: vi.fn(async () => {}),
    newSale: vi.fn(async () => paid()),
    saleSubscriptions: vi.fn(async () => []),
    setSubDates: vi.fn(async () => {}),
    payItem: vi.fn(async () => paid()),
    payOpening: vi.fn(async () => ({ paymentId: "pay-o", alreadyRecorded: false })),
    ensureOpenings: vi.fn(async (_c: string, creates: OpeningCreate[]) => new Map(creates.map((c) => [c.number.toUpperCase(), `OPN-${c.number}`]))),
    paySplit: vi.fn(async () => paid({ kind: "split" } as Partial<PayForResult>)),
    ...over,
  };
}

describe("R-2474 Book selected: last year's invoice made from Zoho, then paid", () => {
  it("one invoice → opening invoice made (1 Apr balance), then paid with the line via reconcile_bank_credit_to_item", async () => {
    const plan = planAll([row("t-1", match([inv("INV/25-26/0412", 59000, hist(59000))], 59000), 59000)], ctx);
    expect(plan[0].ticked).toBe(true);
    const d = deps();
    const run = await bookRows(plan, new Set(["t-1"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.ensureOpenings).toHaveBeenCalledWith("c-acme", [expect.objectContaining({ number: "INV/25-26/0412", total: 59000, balance: 59000 })]);
    expect(d.payItem).toHaveBeenCalledWith({
      transactionId: "t-1", quoteId: null, invoiceId: "OPN-INV/25-26/0412", tdsAmount: 0, tdsRatePct: null, tdsSection: null,
      createSubscription: null, subStart: null, subRenewal: null,
    });
    expect(d.newSale).not.toHaveBeenCalled();
    expect(d.payOpening).not.toHaveBeenCalled();
    expect(run.done[0]).toMatchObject({ outcome: "booked", invoiceId: "OPN-INV/25-26/0412", text: "Opening invoice INV/25-26/0412 made from Zoho and paid — line reconciled." });
  });

  it("several invoices → each made / kept, one split receipt with Zoho's amounts", async () => {
    const m = match([inv("INV/25-26/0412", 59000, hist(59000)), inv("INV/25-26/0413", 11800, hist(11800))], 70800);
    const r = row("t-2", m, 70800);
    r.facts = { ...r.facts!, openings: [{ id: "OPN-9", number: "INV/25-26/0413", date: "2026-01-05", due: 11800 }] };
    const plan = planAll([r], ctx);
    const d = deps();
    const run = await bookRows(plan, new Set(["t-2"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.ensureOpenings).toHaveBeenCalledWith("c-acme", [expect.objectContaining({ number: "INV/25-26/0412" })]);
    expect(d.paySplit).toHaveBeenCalledWith({
      transactionId: "t-2", customerId: "c-acme", sale: null, rest: null,
      items: [{ quote_id: null, invoice_id: "OPN-INV/25-26/0412", amount: 59000 }, { quote_id: null, invoice_id: "OPN-9", amount: 11800 }],
    });
    expect(run.done[0].text).toBe("Opening invoices INV/25-26/0412, INV/25-26/0413 settled (made from Zoho: INV/25-26/0412) — line reconciled.");
  });

  it("a customer new from Zoho is created first, and its opening invoice is made for that customer", async () => {
    const m = match([inv("INV/25-26/0500", 11800, hist(11800, { gstin: null }))], 11800, "Brand New Co");
    const contact = { zohoId: "z-1", name: "Brand New Co", gstin: null, stateCode: "07", country: "India", email: "a@b.in", phone: null, personName: null, gstTreatment: null, customerType: "business" as const };
    const plan = planAll([{ ...row("t-3", m, 11800), facts: null, contact }], ctx);
    const d = deps();
    const run = await bookRows(plan, new Set(["t-3"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(d.createCustomer).toHaveBeenCalledTimes(1);
    expect(d.ensureOpenings).toHaveBeenCalledWith("c-new", [expect.objectContaining({ number: "INV/25-26/0500" })]);
  });

  it("this screen without the opening-invoice step (an old page) → refused before anything is saved", async () => {
    const plan = planAll([row("t-4", match([inv("INV/25-26/0412", 59000, hist(59000))], 59000), 59000)], ctx);
    const d = deps({ ensureOpenings: undefined });
    const run = await bookRows(plan, new Set(["t-4"]), new Set(), d);
    expect(run.error?.reason).toMatch(/Reload the page/);
    expect(d.payItem).not.toHaveBeenCalled();
  });
});

describe("R-2474 ensureOpeningInvoices: import_opening_invoices, keyed by the Zoho number", () => {
  const create: OpeningCreate = {
    zohoId: "zi-1", number: "INV/25-26/0412", invoiceDate: "2025-12-01", dueDate: "2026-01-15",
    total: 59000, balance: 59000, gstin: "07AAACT1234A1Z3", posStateCode: "07",
  };

  it("sends R-1739's row shape (no GST, no revenue) and returns the app's invoice id by number", async () => {
    expect(openingImportRows("c-acme", [create])).toEqual([{
      number: "INV/25-26/0412", invoice_date: "2025-12-01", due_date: "2026-01-15", customer_id: "c-acme",
      total: 59000, balance: 59000, currency: "INR", gstin: "07AAACT1234A1Z3", pos_state_code: "07",
    }]);
    const rpc = vi.fn(async () => ({ data: { imported: 1, skipped: [] }, error: null }));
    const read = vi.fn(async () => [{ id: "INV/25-26/0412", external_number: "INV/25-26/0412", customer_id: "c-acme", document_kind: "opening_invoice" }]);
    const ids = await ensureOpeningInvoices("c-acme", [create], rpc, read);
    expect(rpc).toHaveBeenCalledWith("import_opening_invoices", { p_rows: openingImportRows("c-acme", [create]), p_file_name: "Reconcile from Zoho (bank line)" });
    expect(read).toHaveBeenCalledWith(["INV/25-26/0412"]);
    expect(ids.get("INV/25-26/0412")).toBe("INV/25-26/0412");
  });

  it("a re-run: the import skips the number, the SAME invoice is used — never a second one", async () => {
    const rpc = vi.fn(async () => ({ data: { imported: 0, skipped: ["INV/25-26/0412"] }, error: null }));
    const read = vi.fn(async () => [{ id: "INV/25-26/0412-AB12", external_number: "inv/25-26/0412", customer_id: "c-acme", document_kind: "opening_invoice" }]);
    const ids = await ensureOpeningInvoices("c-acme", [create], rpc, read);
    expect(ids.get("INV/25-26/0412")).toBe("INV/25-26/0412-AB12");
  });

  it("the number is a sale invoice in the app, or another customer's → refused, nothing paid", async () => {
    const rpc = vi.fn(async () => ({ data: { imported: 0, skipped: ["INV/25-26/0412"] }, error: null }));
    await expect(ensureOpeningInvoices("c-acme", [create], rpc, async () => [{ id: "X", external_number: "INV/25-26/0412", customer_id: "c-acme", document_kind: "tax_invoice" }]))
      .rejects.toThrow(/already in the app as a sale invoice/);
    await expect(ensureOpeningInvoices("c-acme", [create], rpc, async () => [{ id: "X", external_number: "INV/25-26/0412", customer_id: "c-other", document_kind: "opening_invoice" }]))
      .rejects.toThrow(/another customer/);
    await expect(ensureOpeningInvoices("c-acme", [create], rpc, async () => [])).rejects.toThrow(/was not made/);
  });

  it("the import refusing (role, locked books …) → its own sentence", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "Only an owner, manager or accountant can import invoices from Zoho." } }));
    await expect(ensureOpeningInvoices("c-acme", [create], rpc, async () => [])).rejects.toThrow(/Only an owner, manager or accountant/);
  });
});
