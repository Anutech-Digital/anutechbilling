/**
 * R-2474 — Reconcile from Zoho: a bank line whose Zoho payment settles LAST YEAR's invoice, when the
 * app has no opening invoice for it. 4 Nov 2026 staging run on Excel 4523: 22 of 59 lines stopped
 * with "No opening balance … Import Zoho's open invoices" — but that CSV import only takes invoices
 * with a balance today, and these were paid in Zoho (by these very lines). They WERE unpaid on
 * 1 Apr, so they are the company's opening receivable: the plan now makes the opening invoice from
 * Zoho's own invoice (total − what was paid / credited before the FY start) and pays it with the line.
 * Names and amounts are made up; Zoho and the database are never called.
 */
import { describe, it, expect } from "vitest";
import {
  openingFromZoho, planAll,
  type BulkLine, type BulkMatchRow, type CustomerFacts, type PlanContext,
} from "./bulk-reconcile-plan";
import { zohoInvoiceHistory, type ZohoInvoiceHistory, type ZohoMatchInvoice, type ZohoMatchLine, type ZohoPaymentMatch } from "./payment-match";

const ctx: PlanContext = {
  customers: [{ id: "c-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3", state_code: "07", country: "India", domain: "acmetools.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-04",
};
const zl = (over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: "INV/25-26/0412", name: "Workspace Starter", sku: null, qty: 1, rate: 50000, itemTotal: null,
  start: "2025-12-01", end: "2026-11-30", months: 12, domain: "acmetools.in", ...over,
});
const hist = (over: Partial<ZohoInvoiceHistory> = {}): ZohoInvoiceHistory => ({
  dueDate: "2026-01-15", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
  payments: [], credits: [], ...over,
});
const inv = (number: string, date: string, total: number, applied: number, history: ZohoInvoiceHistory | null | undefined): ZohoMatchInvoice =>
  ({ zohoId: `zi-${number}`, number, date, amountApplied: applied, total, lines: [zl({ invoiceNumber: number })], history });
function match(customer: string, invoices: ZohoMatchInvoice[], amount: number, tds = 0): ZohoPaymentMatch {
  return {
    by: "utr",
    payment: { zohoId: "zp-1", number: "PAY-1", date: "2026-05-12", amount, reference: "UTR77", customerZohoId: `z-${customer}`, customerName: customer, taxWithheld: tds },
    customer: { zohoId: `z-${customer}`, name: customer, gstin: customer === "Acme Tools" ? "07AAACT1234A1Z3" : null },
    invoices, moreInvoices: [],
  };
}
const bank = (id: string, credit: number, who = "Acme Tools", txnDate = "2026-05-12"): BulkLine =>
  ({ id, txnDate, credit, description: `NEFT CR-HDFC0000001-${who.toUpperCase()}-UTR77`, reference: "UTR77" });
const facts = (over: Partial<CustomerFacts> = {}): CustomerFacts =>
  ({ customerId: "c-acme", openItems: [], openings: [], receipts: [], billed: [], ...over });
const rowOf = (line: BulkLine, m: ZohoPaymentMatch, f: CustomerFacts | null, booksStart: string | null = "2026-04-01"): BulkMatchRow =>
  ({ line, result: { kind: "match", match: m }, contact: null, facts: f, booksStart });

describe("R-2474 zohoInvoiceHistory: what Zoho's invoice says was paid / credited, and when", () => {
  it("reads payments (with TDS), credit notes, write-off, balance, due date, currency, GSTIN, place of supply", () => {
    const h = zohoInvoiceHistory({
      due_date: "2026-01-15", currency_code: "INR", balance: 0, write_off_amount: 0, gst_no: "07AAACT1234A1Z3", place_of_supply: "DL",
      payments: [
        { payment_id: "zp-0", date: "2026-02-10", amount: 30000, tax_amount_withheld: 1000 },
        { payment_id: "zp-1", date: "2026-05-12", amount: 28000 },
      ],
      credits: [{ creditnote_id: "cn-1", credited_date: "2026-03-01", credited_amount: 0 }],
    });
    expect(h).toEqual({
      dueDate: "2026-01-15", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
      payments: [{ paymentId: "zp-0", date: "2026-02-10", amount: 30000, tds: 1000 }, { paymentId: "zp-1", date: "2026-05-12", amount: 28000, tds: 0 }],
      credits: [{ date: "2026-03-01", amount: 0 }],
    });
  });
});

describe("R-2474 openingFromZoho: the opening invoice = Zoho's invoice as it stood on the FY start", () => {
  it("unpaid on 1 Apr: balance = the whole total", () => {
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] })), "2026-04-01");
    expect(out).toEqual({
      ok: true,
      create: { zohoId: "zi-INV/25-26/0412", number: "INV/25-26/0412", invoiceDate: "2025-12-01", dueDate: "2026-01-15", total: 59000, balance: 59000, gstin: "07AAACT1234A1Z3", posStateCode: "07" },
    });
  });

  it("part-paid (payment + TDS) and credited before 1 Apr: balance = total − those", () => {
    const h = hist({
      payments: [{ paymentId: "zp-0", date: "2026-02-10", amount: 30000, tds: 1000 }, { paymentId: "zp-1", date: "2026-05-12", amount: 18000, tds: 0 }],
      credits: [{ date: "2026-03-01", amount: 10000 }],
    });
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 59000, 18000, h), "2026-04-01");
    expect(out.ok && out.create.balance).toBe(18000);
  });

  it("history that does not explain Zoho's balance today → refused (never a guessed opening balance)", () => {
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ balance: 0, payments: [] })), "2026-04-01");
    expect(out).toEqual({ ok: false, problem: expect.stringMatching(/^Zoho's invoice INV\/25-26\/0412 does not add up/) });
  });

  it("fully paid before 1 Apr → refused: it was not part of the opening receivable", () => {
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: [{ paymentId: "zp-0", date: "2026-03-10", amount: 59000, tds: 0 }] })), "2026-04-01");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.problem).toMatch(/nothing was due on 1 Apr 2026/);
  });

  it("paise in the total, a write-off, or a foreign currency → refused with the reason", () => {
    const pay = [{ paymentId: "zp-1", date: "2026-05-12", amount: 590.5, tds: 0 }];
    expect(openingFromZoho(inv("INV/25-26/1", "2025-12-01", 590.5, 590.5, hist({ payments: pay })), "2026-04-01")).toMatchObject({ ok: false, problem: expect.stringMatching(/paise/) });
    expect(openingFromZoho(inv("INV/25-26/2", "2025-12-01", 1000, 900, hist({ writeOff: 100, payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 900, tds: 0 }] })), "2026-04-01")).toMatchObject({ ok: false, problem: expect.stringMatching(/written off/) });
    expect(openingFromZoho(inv("INV/25-26/3", "2025-12-01", 1000, 1000, hist({ currency: "USD", payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 1000, tds: 0 }] })), "2026-04-01")).toMatchObject({ ok: false, problem: expect.stringMatching(/USD/) });
  });
});

describe("R-2474 the plan: last year's invoice with no opening invoice in the app", () => {
  it("one invoice → 'Opening invoice from Zoho → paid', ticked, nothing counted as a sale", () => {
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] }))], 59000);
    const [row] = planAll([rowOf(bank("t-1", 59000), m, facts())], ctx);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.book).toMatchObject({ kind: "opening", lines: [], createSubscription: false, externalNumber: null });
    expect(row.book?.opening).toMatchObject({
      invoiceId: null, number: "INV/25-26/0412", received: 59000, reference: "UTR77",
      parts: [{ invoiceId: null, number: "INV/25-26/0412", amount: 59000, tds: 0, create: expect.objectContaining({ total: 59000, balance: 59000 }) }],
    });
    expect(row.summary).toBe("Opening invoice from Zoho → paid: INV/25-26/0412 (₹59,000 due on 1 Apr 2026) — last year's invoice, no new sale");
  });

  it("the opening balance is as at the books' start; no books' start set → unticked, never a guessed 1 Apr (R-2494)", () => {
    const h = hist({ payments: [{ paymentId: "zp-0", date: "2026-04-20", amount: 9000, tds: 0 }, { paymentId: "zp-1", date: "2026-05-12", amount: 50000, tds: 0 }] });
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 50000, h)], 50000);
    const [withStart] = planAll([rowOf(bank("t-2", 50000), m, facts(), "2026-05-01")], ctx);
    expect(withStart.book?.opening?.parts?.[0].create?.balance).toBe(50000);
    const [noStart] = planAll([rowOf(bank("t-3", 50000), m, facts(), null)], ctx);
    expect(noStart.ticked).toBe(false);
    expect(noStart.book).toBeNull();
    expect(noStart.problems.join(" ")).toMatch(/No books start date: the company's books start is not set/);
  });

  it("the line is more than was due on 1 Apr → unticked, says so", () => {
    const h = hist({ payments: [{ paymentId: "zp-0", date: "2026-02-10", amount: 50000, tds: 0 }, { paymentId: "zp-1", date: "2026-05-12", amount: 9000, tds: 0 }] });
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 9000, h)], 9000);
    const [row] = planAll([rowOf(bank("t-4", 19000), { ...m, payment: { ...m.payment, amount: 19000 } }, facts())], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/INV\/25-26\/0412 had only ₹9,000 due on 1 Apr 2026, but the bank line is ₹19,000/);
  });

  it("an opening invoice already in the app is used (never a second one) — the R-2419 path, unchanged", () => {
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] }))], 59000);
    const [row] = planAll([rowOf(bank("t-5", 59000), m, facts({ openings: [{ id: "OPN-7", number: "INV/25-26/0412", date: "2025-12-01", due: 59000 }] }))], ctx);
    expect(row.book?.opening).toMatchObject({ invoiceId: "OPN-7", received: 59000 });
    expect(row.book?.opening?.parts?.[0]).toMatchObject({ invoiceId: "OPN-7", create: null });
  });

  it("several of last year's invoices in one payment → each made / settled with Zoho's amount applied", () => {
    const pay = (amount: number) => [{ paymentId: "zp-1", date: "2026-05-12", amount, tds: 0 }];
    const m = match("Acme Tools", [
      inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: pay(59000) })),
      inv("INV/25-26/0413", "2026-01-05", 11800, 11800, hist({ payments: pay(11800) })),
    ], 70800);
    const [row] = planAll([rowOf(bank("t-6", 70800), m, facts({ openings: [{ id: "OPN-9", number: "INV/25-26/0413", date: "2026-01-05", due: 11800 }] }))], ctx);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.book?.opening?.parts).toEqual([
      expect.objectContaining({ invoiceId: null, number: "INV/25-26/0412", amount: 59000, tds: 0, create: expect.objectContaining({ balance: 59000 }) }),
      expect.objectContaining({ invoiceId: "OPN-9", number: "INV/25-26/0413", amount: 11800, tds: 0, create: null }),
    ]);
    expect(row.summary).toMatch(/^Opening invoices from Zoho → paid: INV\/25-26\/0412, INV\/25-26\/0413/);
  });

  it("several of last year's invoices with TDS → unticked (Zoho does not say which invoice the TDS is on)", () => {
    const pay = (amount: number) => [{ paymentId: "zp-1", date: "2026-05-12", amount, tds: 0 }];
    const m = match("Acme Tools", [
      inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: pay(59000) })),
      inv("INV/25-26/0413", "2026-01-05", 11800, 11800, hist({ payments: pay(11800) })),
    ], 69800, 1000);
    const [row] = planAll([rowOf(bank("t-7", 69800), m, facts())], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/several of last year's invoices .* with TDS/);
  });

  it("a customer new from Zoho: made from Zoho, then its opening invoice — ticked", () => {
    const m = match("Brand New Co", [inv("INV/25-26/0500", "2025-12-01", 11800, 11800, hist({ gstin: null, payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 11800, tds: 0 }] }))], 11800);
    const contact = { zohoId: "z-Brand New Co", name: "Brand New Co", gstin: null, stateCode: "07", country: "India", email: "a@b.in", phone: null, personName: null, gstTreatment: null, customerType: "business" as const };
    const [row] = planAll([{ ...rowOf(bank("t-8", 11800, "Brand New Co"), m, null), contact }], ctx);
    expect(row.customer?.kind).toBe("new");
    expect(row.problems).toEqual([]);
    expect(row.book?.opening?.parts?.[0].create).toMatchObject({ number: "INV/25-26/0500", balance: 11800 });
  });

  it("mixed last-year + this-year invoices stay unticked with the existing message", () => {
    const pay = (amount: number) => [{ paymentId: "zp-1", date: "2026-05-12", amount, tds: 0 }];
    const m = match("Acme Tools", [
      inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: pay(59000) })),
      inv("INV/26-27/0010", "2026-04-20", 11800, 11800, hist({ payments: pay(11800) })),
    ], 70800);
    const [row] = planAll([rowOf(bank("t-9", 70800), m, facts())], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/mixes last year's and this year's invoices/);
  });

  it("no Zoho history read (an older page) → the old message, unticked", () => {
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 59000, undefined)], 59000);
    const [row] = planAll([rowOf(bank("t-10", 59000), m, facts())], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^No opening balance: Acme Tools has no open opening invoice INV\/25-26\/0412 in the app/);
  });
});

describe("R-2474 review fixes", () => {
  it("this line's own Zoho payment dated before 1 Apr (entered 31 Mar, money in the bank 2 Apr) is not 'paid before'", () => {
    const h = hist({ payments: [{ paymentId: "zp-1", date: "2026-03-31", amount: 40000, tds: 0 }, { paymentId: "zp-2", date: "2026-04-15", amount: 60000, tds: 0 }] });
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 100000, 40000, h), "2026-04-01", "zp-1");
    expect(out.ok && out.create.balance).toBe(100000);
  });

  it("an invoice dated on / after the books' start is a sale of this period — never an opening invoice", () => {
    const out = openingFromZoho(inv("INV/25-26/0412", "2025-10-05", 59000, 59000, hist({ payments: [{ paymentId: "zp-1", date: "2026-06-10", amount: 59000, tds: 0 }] })), "2025-04-01");
    expect(out).toMatchObject({ ok: false, problem: expect.stringMatching(/on or after the books' start/) });
  });

  it("a credit note applied after 1 Apr → refused (the app takes no credit note on an opening invoice)", () => {
    const h = hist({ payments: [{ paymentId: "zp-1", date: "2026-04-20", amount: 45000, tds: 0 }], credits: [{ date: "2026-04-10", amount: 5000 }] });
    expect(openingFromZoho(inv("INV/25-26/0412", "2025-12-01", 50000, 45000, h), "2026-04-01")).toMatchObject({ ok: false, problem: expect.stringMatching(/credit note/) });
  });

  it("an open this-year quote of the same amount does not take last year's money — it is only named", () => {
    const m = match("Acme Tools", [inv("INV/25-26/0412", "2025-12-01", 59000, 59000, hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] }))], 59000);
    const item = { kind: "new", quoteId: "Q-77", invoiceId: null, docDate: "2026-05-01", due: 59000, taxable: 50000, makesSubscription: false, approvalBlock: null };
    const [row] = planAll([rowOf(bank("t-11", 59000), m, facts({ openItems: [item] }))], ctx);
    expect(row.book?.kind).toBe("opening");
    expect(row.book?.item).toBeNull();
    expect(row.notes.join(" ")).toMatch(/Open Q-77 of Acme Tools is for the same ₹59,000 and stays open/);
  });
});
