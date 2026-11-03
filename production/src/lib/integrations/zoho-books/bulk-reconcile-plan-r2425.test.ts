/**
 * R-2425 — export receipts in "Reconcile from Zoho". Owner's case (staging HDFC 4523, 3 Nov):
 * "INW 070826I049902623 USD1024.0@93.6" ₹95,846.40 is Zoho payment $1,024 (Design Box) — the plan
 * said "Amount differs: Zoho ₹1,024, bank ₹95,846". Names are the owner's; values from the bank
 * narrations; Zoho is never called.
 */
import { describe, it, expect } from "vitest";
import { planAll, planRow, type BulkLine, type PlanContext } from "./bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";
import { isLineMoney, paymentFromZoho } from "./payment-match";
import { findInPaymentList } from "./payment-batch";

const customers: PlanContext["customers"] = [
  { id: "c-dbox", name: "Design Box", gstin: null, state_code: null, country: "United States", domain: "designbox.example" },
  { id: "c-desi", name: "Desi Traders", gstin: null, state_code: "07", country: "India", domain: null },
];
const ctx: PlanContext = { customers, subscriptions: [], catalog: [], payers: [], ownNames: [], today: "2026-11-03" };

const zl = (over: Partial<ZohoMatchLine> = {}): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/0501", name: "Website design", sku: null, qty: 1, rate: 1024, itemTotal: null,
  start: null, end: null, months: 0, domain: null, ...over,
});

function usd(customer: string, lines: ZohoMatchLine[], amount: number, over: Partial<ZohoPaymentMatch["payment"]> = {}): ZohoPaymentMatch {
  return {
    by: "utr",
    payment: { zohoId: "pay-usd", number: "9001", date: "2026-08-07", amount, reference: "070826I049902623", customerZohoId: "zc-d", customerName: customer, currency: "USD", exchangeRate: 93.6, ...over },
    customer: { zohoId: "zc-d", name: customer, gstin: null },
    invoices: [{ zohoId: "zi-d", number: "INV/26-27/0501", date: "2026-08-01", amountApplied: amount, total: amount, lines }],
    moreInvoices: [],
  };
}
const line = (credit: number, description: string): BulkLine => ({ id: "t-usd", txnDate: "2026-08-07", credit, description, reference: null });

describe("R-2425: a USD inward remittance is matched in dollars and booked at the bank's rate", () => {
  it("Design Box $1,024 @ 93.6 = ₹95,846.40, credited ₹95,846 (whole rupees) → Ready; the sale is in USD, ₹ = the bank credit, 0% GST", () => {
    const row = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), usd("Design Box", [zl()], 1024), null, ctx);
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.remittance).toEqual({ currency: "USD", amount: 1024, rate: 93.6 });
    expect(row.zoho.currency).toBe("USD");
    expect(row.saleTotal).toBe(95846);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.book?.fx).toEqual({ currency: "USD", rate: 93.6, foreignAmount: 1024 });
    expect(row.book?.lines[0].rate).toBe(95846.4);
    expect(row.book?.tdsAmount).toBe(0);
    expect(row.notes.join(" ")).toContain("Export receipt $1,024 @ ₹93.60");
    expect(row.notes.join(" ")).toContain("zero-rated under LUT");
  });

  it("two lines in dollars convert line by line; the ₹ total still equals the credit (±₹1)", () => {
    const lines = [zl({ name: "Design", qty: 3, rate: 153 }), zl({ name: "Hosting", qty: 1, rate: 300 })];
    const row = planRow(line(71004, "INW 050826I049902875 USD759.0@93.55"), usd("Design Box", lines, 759, { exchangeRate: 93.55 }), null, ctx);
    expect(row.book?.lines.map((l) => l.rate)).toEqual([14313.15, 28065]);
    expect(row.saleTotal).toBe(71004);
    expect(row.problems).toEqual([]);
  });

  it("short in dollars by MORE than bank charges (R-2427: > 5%) → unticked, said in dollars, never 'Amount differs ₹'", () => {
    const row = planRow(line(89808, "INW 050826I049900001 USD960.0@93.55"), usd("Design Box", [zl({ rate: 1024 })], 1024), null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.book?.fx ?? null).toBeNull();
    expect(row.problems[0]).toMatch(/^Short by \$64: Zoho's payment is \$1,024, the bank received \$960 — more than bank charges/);
    expect(row.problems.join(" ")).not.toContain("₹1,024");
  });

  it("the narration does not fit the credit → unticked", () => {
    const row = planRow(line(90000, "INW 070826I049902623 USD1024.0@93.6"), usd("Design Box", [zl()], 1024), null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("which is not the ₹90,000 credited");
  });

  it("Zoho in EUR but the bank received USD → unticked", () => {
    const row = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), usd("Design Box", [zl()], 1024, { currency: "EUR" }), null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems[0]).toMatch(/^Currency differs/);
  });

  it("a Zoho payment in USD on a line with no rate in its narration → unticked", () => {
    const row = planRow(line(95846, "NEFT CR-CITI-DESIGN BOX"), usd("Design Box", [zl()], 1024), null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("no foreign amount and rate");
  });

  it("an app customer in India paying from abroad → unticked (set the country)", () => {
    const row = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), usd("Desi Traders", [zl()], 1024), null, ctx);
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("is in India in the app");
  });

  it("a new overseas customer from Zoho is made with its country; the sale is in USD", () => {
    const contact = { zohoId: "zc-t", name: "Timbergloss", gstin: null, stateCode: null, country: "Australia", email: "a@timbergloss.example", phone: null, personName: null, gstTreatment: "overseas", customerType: "business" as const };
    const row = planRow(line(94460, "INW 270726I049904499 USD1000.0@94.46"), usd("Timbergloss", [zl({ rate: 1000 })], 1000, { exchangeRate: 94.46 }), contact, ctx);
    expect(row.customer).toMatchObject({ kind: "new", country: "Australia" });
    expect(row.book?.fx).toEqual({ currency: "USD", rate: 94.46, foreignAmount: 1000 });
    expect(row.ticked).toBe(true);
  });

  it("an export receipt that matches an open item in ₹ is not paid at the bank's rate (R-2427 pays only an invoice in USD)", () => {
    const facts = { customerId: "c-dbox", openItems: [{ kind: "invoice", quoteId: "Q-1", invoiceId: "INV-9", docDate: "2026-07-01", due: 95846, taxable: 95846, makesSubscription: false, approvalBlock: null }], openings: [], receipts: [], billed: [] };
    const [row] = planAll([{ line: line(95846, "INW 070826I049902623 USD1024.0@93.6"), result: { kind: "match", match: usd("Design Box", [zl()], 1024) }, contact: null, facts, booksStart: null }], ctx);
    expect(row.ticked).toBe(false);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toContain("paid in USD only against an invoice in USD");
  });

  it("an overseas customer billed in ₹ in Zoho, paid by remittance → an ordinary ₹ sale (no fx), Ready", () => {
    const inrBilled = usd("Design Box", [zl({ rate: 95846 })], 95846, { currency: "INR", exchangeRate: undefined });
    const row = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), inrBilled, null, ctx);
    expect(row.book?.fx).toBeNull();
    expect(row.book?.lines[0].rate).toBe(95846);
    expect(row.problems).toEqual([]);
    const noCode = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), usd("Design Box", [zl({ rate: 95846 })], 95846, { currency: undefined }), null, ctx);
    expect(noCode.book?.fx).toBeNull();
    expect(noCode.problems).toEqual([]);
  });

  it("a new USD subscription says its renewal quote is in ₹ until set to USD", () => {
    const sub = zl({ name: "Hosting", rate: 1024, start: "2026-08-07", end: "2027-08-06", months: 12 });
    const row = planRow(line(95846, "INW 070826I049902623 USD1024.0@93.6"), usd("Design Box", [sub], 1024), null, ctx);
    expect(row.book?.createSubscription).toBe(true);
    expect(row.notes.join(" ")).toContain("set the renewal quote to USD");
  });

  it("an INR line is unchanged: no fx, Zoho compared in rupees", () => {
    const inr = usd("Design Box", [zl({ rate: 1000 })], 1000, { currency: undefined, exchangeRate: undefined });
    const row = planRow(line(1000, "NEFT CR-HDFC-DESIGN BOX"), inr, null, ctx);
    expect(row.book?.fx).toBeNull();
    expect(row.remittance).toBeNull();
    expect(row.problems).toEqual([]);
  });
});

describe("R-2425: Zoho payment currency + matching by the foreign amount", () => {
  it("reads currency_code / exchange_rate; INR stays absent", () => {
    expect(paymentFromZoho({ payment_id: "p", amount: 1024, currency_code: "USD", exchange_rate: 93.6 })).toMatchObject({ amount: 1024, currency: "USD", exchangeRate: 93.6 });
    expect(paymentFromZoho({ payment_id: "p", amount: 500, currency_code: "INR", exchange_rate: 1 })).toMatchObject({ currency: "INR" });
    expect(paymentFromZoho({ payment_id: "p", amount: 500, currency_code: "INR", exchange_rate: 1 })).not.toHaveProperty("exchangeRate");
    expect(paymentFromZoho({ payment_id: "p", amount: 500 })).not.toHaveProperty("currency");
  });
  it("a remittance line matches the Zoho payment of the same foreign amount, never the rupee credit", () => {
    const l = { credit: 95846, description: "INW 070826I049902623 USD1024.0@93.6" };
    expect(isLineMoney({ amount: 1024, currency: "USD" }, l)).toBe(true);
    expect(isLineMoney({ amount: 1024 }, l)).toBe(true);
    expect(isLineMoney({ amount: 95846, currency: "USD" }, l)).toBe(false);
    expect(isLineMoney({ amount: 1024, currency: "EUR" }, l)).toBe(false);
    /* an overseas customer billed in ₹ who pays by remittance: still the ₹ credit */
    expect(isLineMoney({ amount: 95846, currency: "INR" }, l)).toBe(true);
    expect(isLineMoney({ amount: 1024, currency: "INR" }, l)).toBe(false);
    expect(isLineMoney({ amount: 1180 }, { credit: 1180, description: "NEFT CR" })).toBe(true);
    expect(isLineMoney({ amount: 1180, currency: "INR" }, { credit: 1180, description: "NEFT CR" })).toBe(true);
    expect(isLineMoney({ amount: 1180, currency: "USD" }, { credit: 1180, description: "NEFT CR" })).toBe(false);
  });
  it("the bulk read (findInPaymentList) finds a USD payment by its dollar amount and date — no UTR in Zoho", () => {
    const pay = (id: string, amount: number, currency?: string) => ({ zohoId: id, number: id, date: "2026-08-06", amount, reference: "", customerZohoId: "z", customerName: "Design Box", ...(currency ? { currency } : {}) });
    const l = { txnDate: "2026-08-07", credit: 95846, description: "INW 070826I049902623 USD1024.0@93.6", reference: null };
    expect(findInPaymentList(l, [pay("a", 1024, "USD"), pay("b", 95846, "USD"), pay("c", 1024, "EUR")])).toMatchObject({ kind: "one", by: "amount_date", payment: { zohoId: "a" } });
  });
});

describe("R-2425: Find in Zoho (the Reconcile sheet) fills a USD bill in ₹ at the bank's rate", () => {
  it("$1,024 against ₹95,846 → the line is ₹95,846.40, with a note", async () => {
    const { zohoPrefill } = await import("./payment-prefill");
    const p = zohoPrefill(usd("Design Box", [zl()], 1024), { customers, catalog: [], txnDate: "2026-08-07", credit: 95846 });
    expect(p.lines[0].rate).toBe(95846);
    expect(p.notes.join(" ")).toContain("Zoho billed in USD");
    const inr = zohoPrefill(usd("Design Box", [zl({ rate: 1000 })], 1000, { currency: undefined }), { customers, catalog: [], txnDate: "2026-08-07", credit: 1000 });
    expect(inr.lines[0].rate).toBe(1000);
    expect(inr.notes).toEqual([]);
  });
  it("a short remittance is never absorbed into the price: rate far from Zoho's → prices stay, a note says why", async () => {
    const { zohoPrefill } = await import("./payment-prefill");
    const p = zohoPrefill(usd("Design Box", [zl()], 1024), { customers, catalog: [], txnDate: "2026-08-05", credit: 93550 });
    expect(p.lines[0].rate).toBe(1024);
    expect(p.notes.join(" ")).toContain("may have kept charges");
  });
});

/* R-2440 (tax memo 3 Nov §1): an export sale at 0% needs the company's LUT for the receipt's FY —
   the plan unticks the line with the Settings step (reconcile_bank_credit_new_sale_fx refuses it too). */
describe("R-2440: Reconcile from Zoho books an export receipt only under an LUT", () => {
  const usdLine = () => line(95846, "INW 070826I049902623 USD1024.0@93.6");
  it("no LUT on file → unticked, says to add it in Settings", () => {
    const row = planRow(usdLine(), usd("Design Box", [zl()], 1024), null, { ...ctx, lut: { number: null, validUpto: null } });
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("No LUT for FY 2026-27 on file");
    expect(row.problems.join(" ")).toContain("Settings");
  });
  it("last year's LUT → unticked", () => {
    const row = planRow(usdLine(), usd("Design Box", [zl()], 1024), null, { ...ctx, lut: { number: "AD070425000999X", validUpto: "2026-03-31" } });
    expect(row.ticked).toBe(false);
    expect(row.problems.join(" ")).toContain("No LUT for FY 2026-27");
    expect(row.notes.join(" ")).not.toContain("AD070425000999X");   // a refused LUT is never named as covering the sale
  });
  it("this year's LUT → Ready, and the note names it", () => {
    const row = planRow(usdLine(), usd("Design Box", [zl()], 1024), null, { ...ctx, lut: { number: "AD070426000123X", validUpto: "2027-03-31" } });
    expect(row.problems).toEqual([]);
    expect(row.ticked).toBe(true);
    expect(row.notes.join(" ")).toContain("LUT AD070426000123X");
  });
  it("an INR line is never asked for an LUT", () => {
    const row = planRow(line(1000, "NEFT CR-HDFC0000001-DESI TRADERS"), usd("Desi Traders", [zl({ rate: 1000 })], 1000, { currency: undefined }), null, { ...ctx, lut: { number: null, validUpto: null } });
    expect(row.problems.join(" ")).not.toContain("LUT");
  });
});
