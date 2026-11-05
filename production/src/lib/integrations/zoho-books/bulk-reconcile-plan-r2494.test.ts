/**
 * R-2494 — Reconcile from Zoho on real Zoho data (5 Nov staging, Excel 4523): ~13 lines stopped with
 * "INV/25-26/xxxx is dated 1/2 Apr 2026, on or after the books' start — a sale of this period, not an
 * opening balance". Right that it is no opening invoice — but Zoho kept the old number series for a
 * day or two after 1 Apr, so the INV/25-26 number made the plan call it last year's. An invoice dated
 * on / after the FY start is a sale of this year whatever its number: it goes down the normal
 * this-year new-sale path, with a note. Names and amounts are made up.
 */
import { describe, it, expect } from "vitest";
import {
  isLastYearInvoice, planAll,
  type BulkLine, type BulkMatchRow, type CustomerFacts, type PlanContext,
} from "./bulk-reconcile-plan";
import type { ZohoInvoiceHistory, ZohoMatchInvoice, ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const ctx: PlanContext = {
  customers: [{ id: "c-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3", state_code: "07", country: "India", domain: "acmetools.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-04",
};
const zl = (over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: "INV/25-26/0999", name: "Workspace Starter", sku: null, qty: 1, rate: 50000, itemTotal: 50000,
  start: "2026-04-01", end: "2027-03-31", months: 12, domain: "acmetools.in", ...over,
});
const hist = (over: Partial<ZohoInvoiceHistory> = {}): ZohoInvoiceHistory => ({
  dueDate: "2026-04-01", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
  payments: [{ paymentId: "zp-1", date: "2026-04-02", amount: 59000, tds: 0 }], credits: [], ...over,
});
const inv = (number: string, date: string, total: number): ZohoMatchInvoice =>
  ({ zohoId: `zi-${number}`, number, date, amountApplied: total, total, lines: [zl({ invoiceNumber: number })], history: hist() });
const match = (invoices: ZohoMatchInvoice[], amount: number): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "zp-1", number: "PAY-1", date: "2026-04-02", amount, reference: "UTR77", customerZohoId: "z-acme", customerName: "Acme Tools" },
  customer: { zohoId: "z-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3" },
  invoices, moreInvoices: [],
});
const bank = (id: string, credit: number, txnDate = "2026-04-02"): BulkLine =>
  ({ id, txnDate, credit, description: "NEFT CR-HDFC0000001-ACME TOOLS-UTR77", reference: "UTR77" });
const facts = (over: Partial<CustomerFacts> = {}): CustomerFacts =>
  ({ customerId: "c-acme", openItems: [], openings: [], receipts: [], billed: [], ...over });
const rowOf = (line: BulkLine, m: ZohoPaymentMatch, booksStart: string | null = "2026-04-01"): BulkMatchRow =>
  ({ line, result: { kind: "match", match: m }, contact: null, facts: facts(), booksStart });

describe("R-2494 isLastYearInvoice: the invoice's DATE decides, not an old number series", () => {
  it("INV/25-26/… dated 1 or 2 Apr 2026 (books start 1 Apr) → this year's sale", () => {
    expect(isLastYearInvoice({ number: "INV/25-26/0999", date: "2026-04-01" }, "2026-04-02", "2026-04-01")).toBe(false);
    expect(isLastYearInvoice({ number: "INV/25-26/1000", date: "2026-04-02" }, "2026-04-03", "2026-04-01")).toBe(false);
  });

  it("no books' start set → the FY start (1 Apr of the line's year) decides the same way", () => {
    expect(isLastYearInvoice({ number: "INV/25-26/0999", date: "2026-04-02" }, "2026-04-05", null)).toBe(false);
  });

  it("unchanged: dated before 1 Apr → last year's; no date → the number's year still decides", () => {
    expect(isLastYearInvoice({ number: "INV/25-26/0412", date: "2026-03-31" }, "2026-04-02", "2026-04-01")).toBe(true);
    expect(isLastYearInvoice({ number: "INV/25-26/0412", date: null }, "2026-04-02", "2026-04-01")).toBe(true);
    expect(isLastYearInvoice({ number: "INV/26-27/0001", date: "2026-04-02" }, "2026-04-02", "2026-04-01")).toBe(false);
  });
});

describe("R-2494 the plan: an INV/25-26 invoice dated on / after 1 Apr goes down the this-year new-sale path", () => {
  it("one such invoice → new sale (no opening refusal), with an 'old number series' note", () => {
    const [row] = planAll([rowOf(bank("t-1", 59000), match([inv("INV/25-26/0999", "2026-04-02", 59000)], 59000))], ctx);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.book?.opening).toBeNull();
    expect(row.problems.join(" ")).not.toMatch(/on or after the books' start|opening balance|last year's/);
    expect(row.notes.join(" ")).toMatch(/INV\/25-26\/0999 is dated 2 Apr 2026 — a sale of this year; Zoho kept the old number series/);
  });

  it("same as an INV/26-27 invoice of that day — the two plan the same book kind", () => {
    const [oldNo] = planAll([rowOf(bank("t-2", 59000), match([inv("INV/25-26/0999", "2026-04-02", 59000)], 59000))], ctx);
    const [newNo] = planAll([rowOf(bank("t-3", 59000), match([inv("INV/26-27/0001", "2026-04-02", 59000)], 59000))], ctx);
    expect(oldNo.book?.kind).toBe(newNo.book?.kind);
    expect(oldNo.ticked).toBe(newNo.ticked);
  });

  it("books starting 1 Apr 2025 (owner, 5 Nov): INV/25-26 is a sale of the books' period — opening only before 1 Apr 2025", () => {
    expect(isLastYearInvoice({ number: "INV/25-26/0412", date: "2025-12-01" }, "2026-05-12", "2025-04-01")).toBe(false);
    expect(isLastYearInvoice({ number: "INV/24-25/0300", date: "2025-03-15" }, "2026-05-12", "2025-04-01")).toBe(true);
    expect(isLastYearInvoice({ number: "INV/24-25/0300", date: null }, "2026-05-12", "2025-04-01")).toBe(true);
    expect(isLastYearInvoice({ number: "INV/25-26/0412", date: null }, "2026-05-12", "2025-04-01")).toBe(false);
    /* Paid in the same year → the normal sale path. */
    const [same] = planAll([rowOf(bank("t-5", 59000, "2025-12-20"), match([inv("INV/25-26/0412", "2025-12-01", 59000)], 59000), "2025-04-01")], ctx);
    expect(same.book?.kind).toBe("new_sale");
    expect(same.problems.join(" ")).not.toMatch(/opening|earlier financial year/);
  });

  it("books from 1 Apr 2025, invoice of FY 2025-26 paid in FY 2026-27 → never a new sale on the bank date (wrong year), unticked with the reason", () => {
    const [row] = planAll([rowOf(bank("t-6", 59000, "2026-05-12"), match([inv("INV/25-26/0412", "2026-02-10", 59000)], 59000), "2025-04-01")], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toMatch(/INV\/25-26\/0412 is dated 10 Feb 2026, in an earlier financial year than this bank line/);
  });

  it("with a last year's invoice dated before 1 Apr in the same payment → still the 'mixes' refusal", () => {
    const [row] = planAll([rowOf(bank("t-4", 118000), match([inv("INV/25-26/0412", "2026-03-20", 59000), inv("INV/25-26/0999", "2026-04-02", 59000)], 118000))], ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toMatch(/mixes last year's and this year's invoices/);
  });
});
