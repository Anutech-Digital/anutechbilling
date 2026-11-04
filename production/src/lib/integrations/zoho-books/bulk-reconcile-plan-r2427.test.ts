/**
 * R-2427 — export receipts in "Reconcile from Zoho": (1) a remittance paying a USD invoice ALREADY in
 * the app at another rate → the invoice is paid in full, the ₹ difference is a forex gain / loss;
 * (2) the remitting bank kept charges abroad (Zoho $1,024, bank $1,000) → the short part × the
 * bank's rate is Bank Charges, never TDS, and the bill is settled in full. Values are the card's;
 * Zoho is never called.
 */
import { describe, it, expect } from "vitest";
import { fxInvoiceSettlement, planAll, planRow, type BulkLine, type CustomerFacts, type OpenItemFact, type PlanContext } from "./bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const customers: PlanContext["customers"] = [
  { id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States", domain: "designbox.example" },
];
const lut = { number: "AD070426000123X", validUpto: "2027-03-31" };
const ctx: PlanContext = { customers, subscriptions: [], catalog: [], payers: [], ownNames: [], today: "2026-11-03", lut };

const zl = (over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: 1024, itemTotal: null,
  start: null, end: null, months: 0, domain: null, ...over,
});
function usd(lines: ZohoMatchLine[], amount: number, rate = 93.6): ZohoPaymentMatch {
  return {
    by: "utr",
    payment: { zohoId: "pay-usd", number: "9001", date: "2026-08-07", amount, reference: "070826I049902623", customerZohoId: "zc-d", customerName: "Design Box", currency: "USD", exchangeRate: rate },
    customer: { zohoId: "zc-d", name: "Design Box", gstin: null },
    invoices: [{ zohoId: "zi-d", number: "INV/26-27/0501", date: "2026-07-01", amountApplied: amount, total: amount, lines }],
    moreInvoices: [],
  };
}
const line = (credit: number, description: string): BulkLine => ({ id: "t-usd", txnDate: "2026-08-07", credit, description, reference: null });
const usdInvoice = (over: Partial<OpenItemFact> = {}): OpenItemFact => ({
  kind: "invoice", quoteId: "Q-A", invoiceId: "INV-A", docDate: "2026-07-01", due: 83000, taxable: 83000,
  makesSubscription: false, approvalBlock: null, currency: "USD", fxRate: 83, ...over,
});
const facts = (items: OpenItemFact[]): CustomerFacts => ({ customerId: "c-dbox", openItems: items, openings: [], receipts: [], billed: [] });
const plan = (l: BulkLine, m: ZohoPaymentMatch, items: OpenItemFact[]) =>
  planAll([{ line: l, result: { kind: "match", match: m }, contact: null, facts: facts(items), booksStart: null }], ctx)[0];

describe("R-2427 (1): a USD invoice in the app paid at another rate → paid in full + forex gain / loss", () => {
  it("$1,000 invoice at ₹83 (₹83,000 due), the bank credits USD1000.0@84.5 = ₹84,500 → Ready: pays INV-A, forex gain ₹1,500", () => {
    const row = plan(line(84500, "INW 070826I049900001 USD1000.0@84.5"), usd([zl({ rate: 1000 })], 1000, 84.5), [usdInvoice()]);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.book?.kind).toBe("pay_item");
    expect(row.book?.item).toMatchObject({ invoiceId: "INV-A", due: 83000 });
    expect(row.book?.item?.fx).toEqual({ currency: "USD", rate: 84.5, foreignAmount: 1000, invoiceRate: 83, foreignDue: 1000, bankCharges: 0, forex: -1500 });
    expect(row.summary).toContain("₹1,500 forex gain");
    expect(row.book?.fx).toBeNull();
    expect(row.notes.join(" ")).not.toContain(": booked in USD");
  });

  it("the rupee rose: $1,000 at ₹83 paid at ₹82 → forex loss ₹1,000", () => {
    const row = plan(line(82000, "INW 070826I049900001 USD1000.0@82"), usd([zl({ rate: 1000 })], 1000, 82), [usdInvoice()]);
    expect(row.book?.item?.fx?.forex).toBe(1000);
    expect(row.summary).toContain("₹1,000 forex loss");
  });

  it("the bank's rate 30% off the invoice's → unticked (probably another invoice)", () => {
    const row = plan(line(108000, "INW 070826I049900001 USD1000.0@108"), usd([zl({ rate: 1000 })], 1000, 108), [usdInvoice()]);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("more than 25% away");
  });

  it("an INR open item for the same ₹ money is still never paid from a USD remittance", () => {
    const row = plan(line(84500, "INW 070826I049900001 USD1000.0@84.5"), usd([zl({ rate: 1000 })], 1000, 84.5),
      [usdInvoice({ currency: null, fxRate: null, due: 84500 })]);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("paid in USD only against an invoice in USD");
  });
});

describe("R-2427 (2): the remitting bank kept charges abroad → Bank Charges, bill settled in full", () => {
  it("USD invoice $1,024 at ₹93.60 (₹95,846), the bank got USD1000.0@93.6 → pays it, Bank Charges ₹2,246, no forex, no TDS", () => {
    const row = plan(line(93600, "INW 080826I049900002 USD1000.0@93.6"), usd([zl()], 1024), [usdInvoice({ due: 95846, taxable: 95846, fxRate: 93.6 })]);
    expect(row.problems).toEqual([]);
    expect(row.book?.kind).toBe("pay_item");
    expect(row.book?.item?.fx).toMatchObject({ bankCharges: 2246, forex: 0, foreignDue: 1024 });
    expect(row.book?.tdsAmount).toBe(0);
    expect(row.summary).toContain("₹2,246 Bank Charges");
  });

  it("no invoice in the app: Zoho $1,024, bank $1,000 @ 93.6 → a new USD sale of ₹95,846, billed 1024, Ready", () => {
    const row = planRow(line(93600, "INW 080826I049900002 USD1000.0@93.6"), usd([zl()], 1024), null, ctx);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.book?.fx).toEqual({ currency: "USD", rate: 93.6, foreignAmount: 1000, billed: 1024 });
    expect(row.saleTotal).toBe(95846);
    expect(row.notes.join(" ")).toContain("₹2,246 is booked as Bank Charges");
  });

  it("rounding noise is not charges: ₹84,993 due at ₹83 ($1,024.01), the bank got exactly $1,024 → no Bank Charges", () => {
    expect(fxInvoiceSettlement(84993, 83, { currency: "USD", amount: 1024, rate: 84.5 }, 86528)).toMatchObject({ bankCharges: 0, forex: -1535, problem: null });
  });

  it("Zoho billed $1,024 but the app invoice is $1,000 (bank got $1,000): no '₹2,246 Bank Charges' note left behind", () => {
    const row = plan(line(93600, "INW 080826I049900002 USD1000.0@93.6"), usd([zl()], 1024), [usdInvoice({ due: 93600, taxable: 93600, fxRate: 93.6 })]);
    expect(row.book?.item?.fx).toMatchObject({ bankCharges: 0, forex: 0 });
    expect(row.notes.join(" ")).not.toContain("Bank Charges");
  });

  it("no remittance (Zoho in ₹): a USD invoice is still matched by its ₹ due, as before", () => {
    const inr: ZohoPaymentMatch = { ...usd([zl({ rate: 83000 })], 83000), payment: { ...usd([], 83000).payment, currency: "INR", exchangeRate: undefined } };
    const row = plan(line(83000, "NEFT CR-CITI-DESIGN BOX"), inr, [usdInvoice()]);
    expect(row.book?.kind).toBe("pay_item");
    expect(row.book?.item).toMatchObject({ invoiceId: "INV-A", fx: null });
  });

  it("the settlement sums match the RPC: part payment (> 5% short) and an over-receipt are refused", () => {
    const r = { currency: "USD", amount: 1000, rate: 93.6 };
    expect(fxInvoiceSettlement(95846, 93.6, r, 93600)).toMatchObject({ bankCharges: 2246, forex: 0, problem: null });
    expect(fxInvoiceSettlement(112320, 93.6, r, 93600).problem).toContain("more than bank charges (5%)");
    expect(fxInvoiceSettlement(84240, 93.6, r, 93600).problem).toContain("the extra is an advance");
  });
});
