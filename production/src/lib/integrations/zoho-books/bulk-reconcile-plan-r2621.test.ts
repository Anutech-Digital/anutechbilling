/**
 * R-2621 — Reconcile from Zoho never books a NEW GST sale for a bank line in a GST-filed month.
 * 9 Nov staging lookup (Excel HDFC 4523, nothing booked): ~69 of 81 ticked rows would have made new 18%
 * sales on FY 2025-26 lines whose GST is already filed (G-FY2526 D2 + D7). Now: a Zoho invoice already
 * imported into the app is PAID (no new sale); one not imported is not bookable, with the next step; an
 * open month books as before. Names and amounts are made up.
 */
import { describe, it, expect } from "vitest";
import {
  planAll,
  type BulkLine, type BulkMatchRow, type CustomerFacts, type PlanContext,
} from "./bulk-reconcile-plan";
import type { ZohoAppSale } from "./zoho-sale-filed";
import type { ZohoInvoiceHistory, ZohoMatchInvoice, ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";

const ctx: PlanContext = {
  customers: [
    { id: "c-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3", state_code: "07", country: "India", domain: "acmetools.in" },
    { id: "c-other", name: "Other Buyer", gstin: "07AAACO5678B1Z1", state_code: "07", country: "India", domain: "other.in" },
  ],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-09",
};
const zl = (number: string, over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: number, name: "Workspace Starter", sku: null, qty: 1, rate: 8610, itemTotal: 8610,
  start: null, end: null, months: null, domain: "acmetools.in", ...over,
});
const hist = (): ZohoInvoiceHistory => ({
  dueDate: "2026-03-20", currency: "INR", balance: 0, writeOff: 0, gstin: "07AAACT1234A1Z3", placeOfSupply: "07",
  payments: [{ paymentId: "zp-1", date: "2026-04-08", amount: 10160, tds: 0 }], credits: [],
});
const inv = (number: string, date: string, total = 10160): ZohoMatchInvoice =>
  ({ zohoId: `zi-${number}`, number, date, amountApplied: total, total, lines: [zl(number)], history: hist() });
const match = (invoices: ZohoMatchInvoice[], amount = 10160): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "zp-1", number: "PAY-1", date: "2026-04-08", amount, reference: "UTR77", customerZohoId: "z-acme", customerName: "Acme Tools" },
  customer: { zohoId: "z-acme", name: "Acme Tools", gstin: "07AAACT1234A1Z3" },
  invoices, moreInvoices: [],
});
const bank = (txnDate: string, credit = 10160): BulkLine =>
  ({ id: `t-${txnDate}`, txnDate, credit, description: "NEFT CR-HDFC0000001-ACME TOOLS-UTR77", reference: "UTR77" });
const facts = (over: Partial<CustomerFacts> = {}): CustomerFacts =>
  ({ customerId: "c-acme", openItems: [], openings: [], receipts: [], billed: [], ...over });
const sale = (over: Partial<ZohoAppSale> = {}): ZohoAppSale => ({
  number: "INV/25-26/2589", invoiceId: "INV/25-26/2589", customerId: "c-acme", date: "2026-03-20", due: 10160, taxable: 8610, ...over,
});
/** Books from 1 Apr 2025; GST filed up to 30 Sep 2026 → every listed day up to then is filed. */
const row = (line: BulkLine, m: ZohoPaymentMatch, extra: Partial<BulkMatchRow> = {}): BulkMatchRow => ({
  line, result: { kind: "match", match: m }, contact: null, facts: facts(), booksStart: "2025-04-01",
  gstFiled: [line.txnDate, ...m.invoices.map((i) => i.date!.slice(0, 10))].filter((d) => d <= "2026-09-30"),
  zohoSales: [], ...extra,
});
const text = (r: { problems: string[] }) => r.problems.join(" ");

describe("R-2621 filed month, Zoho invoice NOT in the app → never a new sale", () => {
  it("FY 2025-26 line + FY 2025-26 invoice (both filed) → unticked, no book, says import it first", () => {
    const [r] = planAll([row(bank("2025-12-10"), match([inv("INV/25-26/1913", "2025-12-01")]))], ctx);
    expect(r.ticked).toBe(false);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/GST for Dec 2025 is already filed — a new sale on 10 Dec 2025 would change a filed return/);
    expect(text(r)).toMatch(/Import Zoho's invoice INV\/25-26\/1913 first \(Invoices → FY sales from Zoho\), then run this again/);
  });

  it("8 Apr 2026 line paying INV/25-26/2589 dated 2 Apr 2026 (old number series, filed month) → refused, not a new FY 2026-27 sale", () => {
    const [r] = planAll([row(bank("2026-04-08"), match([inv("INV/25-26/2589", "2026-04-02")]))], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/GST for Apr 2026 is already filed/);
  });

  it("an OPEN month line (Oct 2026) whose Zoho invoice is dated in a filed month (Sep 2026) → refused too", () => {
    const [r] = planAll([row(bank("2026-10-05"), match([inv("INV/26-27/0500", "2026-09-28")]))], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/Zoho's invoice INV\/26-27\/0500 is dated 28 Sept? 2026 — GST for Sep 2026 is already filed/);
  });

  it("no Zoho invoice at all (a payment with no invoice) in a filed month → refused, reconcile by hand", () => {
    const [r] = planAll([row(bank("2026-05-02"), match([]))], ctx);
    expect(r.book?.kind === "new_sale").toBe(false);
  });
});

describe("R-2621 Zoho invoice already in the app (imported FY sale) → pays THAT invoice", () => {
  it("filed month, imported, due = money → pay_item on it, no new sale, ticked", () => {
    const [r] = planAll([row(bank("2026-04-08"), match([inv("INV/25-26/2589", "2026-03-20")]), { zohoSales: [sale()] })], ctx);
    expect(r.book?.kind).toBe("pay_item");
    expect(r.book?.item).toMatchObject({ invoiceId: "INV/25-26/2589", quoteId: null, due: 10160 });
    expect(r.book?.lines).toEqual([]);
    expect(r.summary).toMatch(/Pays Zoho's invoice INV\/25-26\/2589 \(in the app as INV\/25-26\/2589, ₹10,160 due\) — no new sale/);
    expect(r.ticked).toBe(true);
  });

  it("also in an OPEN month: an imported Zoho invoice is paid, never sold again", () => {
    const [r] = planAll([row(bank("2026-10-05"), match([inv("INV/26-27/0600", "2026-10-01")]), { gstFiled: [], zohoSales: [sale({ number: "INV/26-27/0600", invoiceId: "INV-0600", date: "2026-10-01" })] })], ctx);
    expect(r.book?.kind).toBe("pay_item");
    expect(r.book?.item?.invoiceId).toBe("INV-0600");
  });

  it("part payment (money below the due) → pays it, with a note of what stays due", () => {
    const [r] = planAll([row(bank("2026-04-08", 5000), match([inv("INV/25-26/2589", "2026-03-20")], 5000), { zohoSales: [sale()] })], ctx);
    expect(r.book?.kind).toBe("pay_item");
    expect(r.notes.join(" ")).toMatch(/₹5,160 stays due/);
  });

  it("already paid in the app (due 0) → refused, match the line to its receipt", () => {
    const [r] = planAll([row(bank("2026-04-08"), match([inv("INV/25-26/2589", "2026-03-20")]), { zohoSales: [sale({ due: 0 })] })], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/INV\/25-26\/2589 is already paid in the app — match this line to its receipt by hand/);
  });

  it("more money than its due → refused", () => {
    const [r] = planAll([row(bank("2026-04-08"), match([inv("INV/25-26/2589", "2026-03-20")]), { zohoSales: [sale({ due: 4000 })] })], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/has only ₹4,000 due/);
  });

  it("imported under another app customer → refused", () => {
    const [r] = planAll([row(bank("2026-04-08"), match([inv("INV/25-26/2589", "2026-03-20")]), { zohoSales: [sale({ customerId: "c-other" })] })], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/is in the app under another customer/);
  });

  it("several Zoho invoices on one payment, in the app → refused (Record payment across them)", () => {
    const m = match([inv("INV/25-26/2589", "2026-03-20", 5080), inv("INV/25-26/2590", "2026-03-21", 5080)]);
    const [r] = planAll([row(bank("2026-04-08"), m, { zohoSales: [sale({ due: 5080 }), sale({ number: "INV/25-26/2590", invoiceId: "INV/25-26/2590", due: 5080 })] })], ctx);
    expect(r.book).toBeNull();
    expect(text(r)).toMatch(/Record payment/);
  });
});

describe("R-2621 open month, not imported → a new sale as before", () => {
  it("Oct 2026 line + Oct 2026 invoice, nothing filed → new_sale, ticked", () => {
    const [r] = planAll([row(bank("2026-10-05"), match([inv("INV/26-27/0700", "2026-10-01")]), { gstFiled: [] })], ctx);
    expect(r.book?.kind).toBe("new_sale");
    expect(text(r)).not.toMatch(/already filed/);
  });
});
