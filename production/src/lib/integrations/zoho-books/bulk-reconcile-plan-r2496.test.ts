/**
 * R-2496 (G-FY2526) — Reconcile from Zoho reads the company's ONE books start (tenants.books_start_date,
 * else opening date + 1): "last year" = dated before the books start, never the FY in the invoice
 * number or 1 Apr of the bank line's year. Owner decision 5 Nov: Excel's books start 1 Apr 2025, so an
 * INV/25-26 invoice is a sale inside the books (FY 2025-26), not an opening balance; an INV/24-25
 * invoice is the opening receivable as at 1 Apr 2025. Names and amounts are made up.
 */
import { describe, it, expect } from "vitest";
import { isLastYearInvoice, planAll, type BulkLine, type BulkMatchRow, type CustomerFacts, type PlanContext } from "./bulk-reconcile-plan";
import type { ZohoInvoiceHistory, ZohoMatchInvoice, ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const ctx: PlanContext = {
  customers: [{ id: "c-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3", state_code: "07", country: "India", domain: "acmetools.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-05",
};
const zl = (number: string, start: string): ZohoMatchLine => ({
  invoiceNumber: number, name: "Workspace Starter", sku: null, qty: 1, rate: 50000, itemTotal: null,
  start, end: null, months: 12, domain: "acmetools.in",
});
const hist = (over: Partial<ZohoInvoiceHistory> = {}): ZohoInvoiceHistory => ({
  dueDate: "2025-03-30", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
  payments: [], credits: [], ...over,
});
const inv = (number: string, date: string, total: number, history: ZohoInvoiceHistory): ZohoMatchInvoice =>
  ({ zohoId: `zi-${number}`, number, date, amountApplied: total, total, lines: [zl(number, date)], history });
const match = (invoices: ZohoMatchInvoice[], amount: number, date: string): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "zp-1", number: "PAY-1", date, amount, reference: "UTR77", customerZohoId: "z-acme", customerName: "Acme Tools" },
  customer: { zohoId: "z-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3" },
  invoices, moreInvoices: [],
});
const bank = (id: string, credit: number, txnDate: string): BulkLine =>
  ({ id, txnDate, credit, description: "NEFT CR-HDFC0000001-ACME TOOLS-UTR77", reference: "UTR77" });
const facts: CustomerFacts = { customerId: "c-acme", openItems: [], openings: [], receipts: [], billed: [] };
const rowOf = (line: BulkLine, m: ZohoPaymentMatch, booksStart: string | null): BulkMatchRow =>
  ({ line, result: { kind: "match", match: m }, contact: null, facts, booksStart });

describe("R-2496 books from 1 Apr 2025 — the books start decides, not the number or the line's year", () => {
  it("INV/25-26 dated inside FY 2025-26 is not last year's, even when paid in FY 2026-27", () => {
    expect(isLastYearInvoice({ number: "INV/25-26/0412", date: "2025-12-01" }, "2026-05-12", "2025-04-01")).toBe(false);
  });

  it("INV/24-25 dated before 1 Apr 2025 → the opening invoice is Zoho's invoice as it stood on 1 Apr 2025", () => {
    const h = hist({ payments: [
      { paymentId: "zp-0", date: "2025-03-20", amount: 9000, tds: 0 },  /* before the books → inside the opening */
      { paymentId: "zp-9", date: "2025-06-10", amount: 20000, tds: 0 }, /* inside the books → not in the opening */
      { paymentId: "zp-1", date: "2026-05-12", amount: 30000, tds: 0 },
    ] });
    const [row] = planAll([rowOf(bank("t-1", 30000, "2026-05-12"), match([inv("INV/24-25/0300", "2025-03-15", 59000, h)], 30000, "2026-05-12"), "2025-04-01")], ctx);
    expect(row.book?.opening?.parts?.[0].create).toMatchObject({ number: "INV/24-25/0300", balance: 50000 });
    expect(row.summary).toMatch(/due on 1 Apr 2025/);
  });

  it("the same line with no books start → unticked, says where to set it (never a guessed 1 Apr)", () => {
    const h = hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] });
    const [row] = planAll([rowOf(bank("t-2", 59000, "2026-05-12"), match([inv("INV/24-25/0300", "2025-03-15", 59000, h)], 59000, "2026-05-12"), null)], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toMatch(/No books start date.*Accounting → Overview → Books start/);
  });

  it("review: an UNDATED INV/25-26 paid in FY 2026-27 is never a new sale on the bank date (its number says FY 2025-26)", () => {
    const h = hist({ payments: [{ paymentId: "zp-1", date: "2026-05-12", amount: 59000, tds: 0 }] });
    const undated = { ...inv("INV/25-26/0412", "2025-12-01", 59000, h), date: null };
    const [row] = planAll([rowOf(bank("t-3", 59000, "2026-05-12"), match([undated], 59000, "2026-05-12"), "2025-04-01")], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toMatch(/INV\/25-26\/0412 is of an earlier year by its number.*wrong year/);
  });
});
