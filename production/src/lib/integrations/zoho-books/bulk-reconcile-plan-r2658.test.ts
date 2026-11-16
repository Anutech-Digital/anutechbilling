/**
 * R-2658 — "Reconcile from Zoho" for a USD inward line paired by its foreign amount ("fx_amount"):
 * what the plan books and which rows "Book all clean" may take without a person. Values are made up
 * (the shapes are HDFC's); Zoho is never called.
 */
import { describe, it, expect } from "vitest";
import { planAll, type BulkLine, type CustomerFacts, type OpenItemFact, type PlanContext } from "./bulk-reconcile-plan";
import { FX_SURE_MAX_AGE_MS, isCleanPair, isSureFxPay, previewCounts } from "./bulk-book-run";
import { findInPaymentList } from "./payment-batch";
import type { ZohoMatchLine, ZohoPaymentMatch, ZohoPaymentRow } from "./payment-match";

const customers: PlanContext["customers"] = [
  { id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States", domain: "designbox.example" },
];
const lut = { number: "AD070426000123X", validUpto: "2027-03-31" };
const ctx: PlanContext = { customers, subscriptions: [], catalog: [], payers: [], ownNames: [], today: "2026-11-03", lut };

const zl = (over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: 1000, itemTotal: null,
  start: null, end: null, months: 0, domain: null, ...over,
});
const payment = (over: Partial<ZohoPaymentRow> = {}): ZohoPaymentRow => ({
  zohoId: "pay-usd", number: "9001", date: "2026-08-01", amount: 1000, reference: "", customerZohoId: "zc-d", customerName: "Design Box",
  currency: "USD", exchangeRate: 83, ...over,
});
function match(by: ZohoPaymentMatch["by"], p: ZohoPaymentRow = payment(), over: Partial<ZohoPaymentMatch> = {}): ZohoPaymentMatch {
  return {
    by, matchedAt: new Date().toISOString(), ...over, payment: p, customer: { zohoId: "zc-d", name: "Design Box", gstin: null },
    invoices: [{ zohoId: "zi-d", number: "INV/26-27/0501", date: "2026-07-01", amountApplied: p.amount, total: p.amount, lines: [zl({ rate: p.amount })] }],
    moreInvoices: [],
  };
}
/* The bank's line: no customer name, only the foreign amount and the bank's rate. */
const line = (over: Partial<BulkLine> = {}): BulkLine => ({
  id: "t-usd", txnDate: "2026-08-07", credit: 84500, description: "INW 070826I049900001 USD1000.0@84.5", reference: "0000070826114968", ...over,
});
const usdInvoice = (over: Partial<OpenItemFact> = {}): OpenItemFact => ({
  kind: "invoice", quoteId: "Q-A", invoiceId: "INV-A", docDate: "2026-07-01", due: 83000, taxable: 83000,
  makesSubscription: false, approvalBlock: null, currency: "USD", fxRate: 83, ...over,
});
const facts = (items: OpenItemFact[]): CustomerFacts => ({ customerId: "c-dbox", openItems: items, openings: [], receipts: [], billed: [] });
const plan = (l: BulkLine, m: ZohoPaymentMatch, items: OpenItemFact[]) =>
  planAll([{ line: l, result: { kind: "match", match: m }, contact: null, facts: facts(items), booksStart: null }], ctx)[0];

describe("R-2658 a USD inward line paired by its USD amount", () => {
  it("one Zoho payment of the same USD amount → the open USD invoice is paid with the exchange difference, and the row is clean", () => {
    const l = line();
    const found = findInPaymentList(l, [payment()], [l]);
    expect(found).toMatchObject({ kind: "one", by: "fx_amount" });
    const row = plan(l, match("fx_amount"), [usdInvoice()]);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.zoho.by).toBe("fx_amount");
    expect(row.book?.kind).toBe("pay_item");
    /* ₹ realised = the invoice's own ₹83,000 due; the bank credited ₹84,500 → ₹1,500 exchange gain. */
    expect(row.book?.item).toMatchObject({ invoiceId: "INV-A", due: 83000 });
    expect(row.book?.item?.fx).toEqual({ currency: "USD", rate: 84.5, foreignAmount: 1000, invoiceRate: 83, foreignDue: 1000, bankCharges: 0, forex: -1500 });
    expect(row.notes.join(" ")).toContain("Matched by USD amount: Zoho payment 9001");
    expect(row.notes.join(" ")).toContain("within 10 days");
    expect(isSureFxPay(row)).toBe(true);
    expect(isCleanPair(row)).toBe(true);
    expect(previewCounts([row], new Set())).toEqual({ clean: 1, cleanTotal: 84500, needLook: 0 });
  });

  it("the rupee rose: ₹83 invoice paid at ₹82 → exchange loss ₹1,000, still clean", () => {
    const row = plan(line({ credit: 82000, description: "INW 070826I049900001 USD1000.0@82" }), match("fx_amount"), [usdInvoice()]);
    expect(row.book?.item?.fx?.forex).toBe(1000);
    expect(isCleanPair(row)).toBe(true);
  });

  it("the same pairing found only by amount + date (a rival line, or Zoho gave no currency) is never clean", () => {
    const row = plan(line(), match("amount_date"), [usdInvoice()]);
    expect(row.ticked).toBe(true);
    expect(isCleanPair(row)).toBe(false);
    expect(row.notes.join(" ")).not.toContain("Matched by USD amount");
  });

  it("a person unticked it → not clean", () => {
    const row = plan(line(), match("fx_amount"), [usdInvoice()]);
    expect(isCleanPair(row, new Set([row.txnId]))).toBe(false);
  });

  it("no open invoice in the app → a NEW export sale: ticked for a person, never booked by Book all clean", () => {
    const row = plan(line(), match("fx_amount"), []);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.book?.fx).toMatchObject({ currency: "USD", rate: 84.5, foreignAmount: 1000 });
    expect(isSureFxPay(row)).toBe(false);
    expect(isCleanPair(row)).toBe(false);
  });

  it("two open invoices same USD due → 'pick the right one', nothing booked", () => {
    const row = plan(line(), match("fx_amount"), [usdInvoice(), usdInvoice({ invoiceId: "INV-B", quoteId: "Q-B" })]);
    expect(row.book).toBeNull();
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("pick the right one");
    expect(isCleanPair(row)).toBe(false);
  });

  it("the bank got more USD than the invoice has due → refused (an advance), not clean", () => {
    const row = plan(line({ credit: 84500 }), match("fx_amount"), [usdInvoice({ due: 80000, taxable: 80000, fxRate: 83 })]);
    expect(isCleanPair(row)).toBe(false);
    expect(row.book?.kind === "pay_item" && row.ticked).toBe(false);
  });

  it("Zoho's amount 50 cents under the bank's → 'Amount differs', not ticked", () => {
    const row = plan(line(), match("fx_amount", payment({ amount: 999.5 })), [usdInvoice()]);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("Amount differs");
    expect(isCleanPair(row)).toBe(false);
  });

  it("an open ₹ invoice of the same rupees is never paid from the USD receipt", () => {
    const row = plan(line(), match("fx_amount"), [usdInvoice({ currency: null, fxRate: null, due: 84500 })]);
    expect(row.ticked).toBe(false);
    expect(isCleanPair(row)).toBe(false);
  });

  it("a customer in India in the app is never a clean export receipt", () => {
    const india: PlanContext = { ...ctx, customers: [{ ...customers[0], country: "India", state_code: "07" }] };
    const row = planAll([{ line: line(), result: { kind: "match", match: match("fx_amount") }, contact: null, facts: facts([]), booksStart: null }], india)[0];
    expect(row.ticked).toBe(false);
    expect(isCleanPair(row)).toBe(false);
  });

  it("two lines of one run that could both be the one Zoho payment → neither is clean", () => {
    const a = line({ id: "a", txnDate: "2026-08-05" });
    const b = line({ id: "b", txnDate: "2026-08-09" });
    const pays = [payment({ date: "2026-08-06" })];
    for (const l of [a, b]) {
      const found = findInPaymentList(l, pays, [a, b]);
      expect(found).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line") });
      if (found.kind !== "one") continue;
      const row = plan(l, match(found.by, payment(), { notSure: found.notSure }), [usdInvoice()]);
      expect(row.ticked).toBe(true);   // a person may still tick and book it
      expect(row.notes.join(" ")).toContain("Not sure: Another bank line");
      expect(isCleanPair(row)).toBe(false);
    }
  });
});

describe("R-2658 one export receipt per invoice in a run", () => {
  it("two USD lines (a month apart, each with its own Zoho payment) planned on the customer's ONE open USD invoice → the first pays it, the second is not booked", () => {
    const a = line({ id: "a", txnDate: "2026-08-07" });
    const b = line({ id: "b", txnDate: "2026-09-07", credit: 85000, description: "INW 070926I049900002 USD1000.0@85" });
    const rows = planAll([
      { line: a, result: { kind: "match", match: match("fx_amount") }, contact: null, facts: facts([usdInvoice()]), booksStart: null },
      { line: b, result: { kind: "match", match: match("fx_amount", payment({ zohoId: "pay-2", number: "9002", date: "2026-09-05" })) }, contact: null, facts: facts([usdInvoice()]), booksStart: null },
    ], ctx);
    expect(isCleanPair(rows[0])).toBe(true);
    expect(rows[1].book).toBeNull();
    expect(rows[1].ticked).toBe(false);
    expect(rows[1].problems.join(" ")).toContain("Another line in this run already pays INV-A in full");
    expect(isCleanPair(rows[1])).toBe(false);
  });

  it("a rival line whose narration does not fit its credit still makes the pair not sure", () => {
    const a = line({ id: "a", txnDate: "2026-08-05" });
    const odd = line({ id: "odd", txnDate: "2026-08-09", credit: 80000 });
    expect(findInPaymentList(a, [payment({ date: "2026-08-06" })], [a, odd])).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line") });
  });
});

describe("R-2658 what 'sure' needs (isSureFxPay)", () => {
  it("a pairing older than an hour is not clean any more (a new line or Zoho payment may have come) — Start again", () => {
    const old = new Date(Date.now() - FX_SURE_MAX_AGE_MS - 60_000).toISOString();
    const row = plan(line(), match("fx_amount", payment(), { matchedAt: old }), [usdInvoice()]);
    expect(row.ticked).toBe(true);
    expect(isCleanPair(row)).toBe(false);
    expect(isSureFxPay(row, Date.parse(old) + 1000)).toBe(true);
    /* No time on the row (a plan kept from before this card) → not sure. */
    expect(isCleanPair(plan(line(), match("fx_amount", payment(), { matchedAt: null }), [usdInvoice()]))).toBe(false);
  });

  it("the three USD figures must be the SAME: Zoho USD 1,000.80 against the bank's USD 1,000 (charges kept abroad) is booked only by a person", () => {
    const row = plan(line(), match("fx_amount", payment({ amount: 1000.8 })), [usdInvoice({ due: 83066, taxable: 83066 })]);
    expect(row.book?.kind).toBe("pay_item");
    expect(row.book?.item?.fx?.bankCharges).toBeGreaterThan(0);
    expect(row.ticked).toBe(true);
    expect(isCleanPair(row)).toBe(false);
  });

  it("an invoice whose USD due is not the receipt's USD (5 cents under) is not clean", () => {
    const row = plan(line(), match("fx_amount"), [usdInvoice({ due: 82996, taxable: 82996 })]);
    if (row.book?.kind === "pay_item" && row.ticked) expect(isCleanPair(row)).toBe(false);
    expect(isCleanPair(row)).toBe(false);
  });
});

describe("R-2658 who keeps the invoice when two rows of a run pay it", () => {
  const two = (first: ZohoPaymentMatch, second: ZohoPaymentMatch, ctxFor: PlanContext = ctx) => planAll([
    { line: line({ id: "a", txnDate: "2026-09-07", credit: 85000, description: "INW 070926I049900002 USD1000.0@85" }), result: { kind: "match", match: first }, contact: null, facts: facts([usdInvoice()]), booksStart: null },
    { line: line({ id: "b", txnDate: "2026-08-07" }), result: { kind: "match", match: second }, contact: null, facts: facts([usdInvoice()]), booksStart: null },
  ], ctxFor);

  it("a sure pair wins over one that is not sure, whatever the order", () => {
    const rows = two(match("fx_amount", payment({ zohoId: "p2", number: "9002", date: "2026-09-05" }), { notSure: "Another bank line (2026-09-01, the same USD amount) could be this Zoho payment." }), match("fx_amount"));
    expect(rows[0].book).toBeNull();
    expect(rows[0].problems.join(" ")).toContain("Another line in this run already pays INV-A in full");
    expect(rows[1].book?.item?.invoiceId).toBe("INV-A");
    expect(isCleanPair(rows[1])).toBe(true);
  });

  it("a row that is not bookable anyway (Zoho's amount differs) never takes the invoice from a sure row", () => {
    const rows = two(match("fx_amount", payment({ zohoId: "p2", number: "9002", date: "2026-09-05", amount: 999.5 })), match("fx_amount"));
    expect(rows[0].ticked).toBe(false);
    expect(rows[0].problems.join(" ")).toContain("Amount differs");
    expect(rows[0].problems.join(" ")).not.toContain("Another line in this run");
    expect(isCleanPair(rows[1])).toBe(true);
  });
});
