/**
 * R-2836 (Renewals history H1 — Pardeep 15 Nov: "quote/invoice/payment history ka pop-up"): the drawer's
 * history in four tabs (All · Quotes · Invoices · Payments) with each payment under the invoice it paid
 * and the period that invoice covers — the customer page's link rule (invoice-payment-links.ts), never a copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lastDocsBySubscription, attachDocDetails, type DocInvoice, type DocQuote, type LastDocs, type LastDocsInput } from "./last-docs";
import { lastPaidBySubscription, type LastPaidInput } from "./last-paid";
import { drawerDocRows, drawerPaymentRows, NO_RECEIPT_METHOD } from "./drawer";
import { historyTabs, NOT_AGAINST_INVOICE, type HistoryInvoiceRow } from "./drawer-history";

const TODAY = "2026-11-15";
const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
type Sub = LastDocsInput["subs"][number];
const docsOf = (sub: Sub, over: Partial<LastDocsInput>, periods: Record<string, string> = {}): LastDocs => {
  const m = lastDocsBySubscription({ subs: [sub], quotes: [], billings: [], invoices: [], ...over }, { all: true });
  const d = attachDocDetails(m, { quotes: [], notes: new Map() }).get(sub.id)!;
  /* the period attachDocDetails reads from the quote lines (Subscription period) — set here directly */
  const withPeriod = <T extends { id: string; period: string | null }>(x: T) => ({ ...x, period: periods[x.id] ?? x.period });
  return { ...d, allInvoices: d.allInvoices?.map(withPeriod), allQuotes: d.allQuotes?.map(withPeriod) };
};
type Pay = LastPaidInput["payments"][number];
const pay = (over: Partial<Pay> & { id: string }): Pay => ({
  amount: 11800, method: "bank_transfer", status: "received", received_at: "2026-01-10T05:00:00Z",
  refunded_at: null, quote_id: null, invoice_id: null, ...over,
});
const paidOf = (sub: Sub, input: Omit<LastPaidInput, "subs">) => lastPaidBySubscription({ subs: [sub], ...input }, { historySize: Infinity }).get(sub.id);
const invoiceRow = (rows: readonly { kind: string; id?: string }[], id: string) =>
  rows.find((r) => r.kind === "invoice" && r.id === id) as HistoryInvoiceRow | undefined;

describe("R-2836 USD Plan: the $500 sits under its invoice with the period it paid", () => {
  const sub: Sub = { id: "USD", quote_id: "Q-CT2737-F", renewal_quote_id: null, start_date: "2025-11-09" };
  const docs = docsOf(sub, {
    quotes: [q({ id: "Q-CT2737-F", invoice_id: "INV-CT2737-F", amount: 100800 })],
    invoices: [inv({ id: "INV-CT2737-F", quote_id: "Q-CT2737-F", amount: 100800, paid_amount: 42000, currency: "USD", fx_rate: 84 })],
  }, { "INV-CT2737-F": "9 Nov 2025 – 8 Nov 2026" });

  it("no receipt row (R-2818): the gap line is under INV-CT2737-F in dollars, 'for <invoice> · <period>'", () => {
    const t = historyTabs(docs, undefined, { subQuoteId: sub.quote_id, todayIst: TODAY });
    const row = invoiceRow(t.invoices, "INV-CT2737-F")!;
    expect(row.payments).toHaveLength(1);
    expect(row.payments[0]).toMatchObject({ amount: "$500", method: NO_RECEIPT_METHOD, noReceipt: true, forWords: "for INV-CT2737-F · 9 Nov 2025 – 8 Nov 2026" });
    expect(t.payments.map((p) => p.forWords)).toEqual(["for INV-CT2737-F · 9 Nov 2025 – 8 Nov 2026"]);
    expect(invoiceRow(t.all, "INV-CT2737-F")!.payments).toEqual(row.payments);
    expect(t.unlinked).toBeNull();
  });

  it("its $500 receipt recorded on the invoice → one line under it, no gap line", () => {
    const paid = paidOf(sub, {
      linkedQuotes: [{ id: "Q-CT2737-F", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-CT2737-F" }],
      billings: [], invoices: [{ id: "INV-CT2737-F", quote_id: "Q-CT2737-F" }],
      payments: [pay({ id: "P1", amount: 42000, invoice_id: "INV-CT2737-F", received_at: "2026-11-01T05:00:00Z" })],
    });
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    const row = invoiceRow(t.invoices, "INV-CT2737-F")!;
    expect(row.payments.map((p) => p.id)).toEqual(["P1"]);
    expect(row.payments[0]).toMatchObject({ noReceipt: false, amount: "$500", partOf: null, date: "1 Nov 2026", forWords: "for INV-CT2737-F · 9 Nov 2025 – 8 Nov 2026" });
    expect(t.counts).toEqual({ all: 3, quotes: 1, invoices: 1, payments: 1 });
    /* the Payments tab keeps the receipt's own ₹ (as the drawer does today) */
    expect(t.payments[0]).toMatchObject({ id: "P1", amount: "₹42,000", forWords: "for INV-CT2737-F · 9 Nov 2025 – 8 Nov 2026" });
  });
});

describe("R-2836 a quote with two invoices settles oldest first (the database's rule)", () => {
  const sub: Sub = { id: "S2", quote_id: "Q-2", renewal_quote_id: null, start_date: "2025-10-01" };
  const docs = docsOf(sub, {
    quotes: [q({ id: "Q-2", invoice_id: "INV-B", amount: 20000 })],
    invoices: [
      inv({ id: "INV-B", quote_id: "Q-2", invoice_date: "2026-04-01", created_at: "2026-04-01T05:00:00Z", amount: 10000, paid_amount: 4000 }),
      inv({ id: "INV-A", quote_id: "Q-2", invoice_date: "2025-10-01", amount: 10000, paid_amount: 10000, status: "paid" }),
    ],
  }, { "INV-A": "Oct 2025 – Mar 2026", "INV-B": "Apr 2026 – Sep 2026" });
  const paid = paidOf(sub, {
    linkedQuotes: [{ id: "Q-2", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-B" }],
    billings: [], invoices: [{ id: "INV-A", quote_id: "Q-2" }, { id: "INV-B", quote_id: "Q-2" }],
    payments: [pay({ id: "P-14K", amount: 14000, quote_id: "Q-2", received_at: "2026-05-01T05:00:00Z" })],
  });

  it("one ₹14,000 receipt on the quote: ₹10,000 under the older INV-A, ₹4,000 under INV-B, each with its period", () => {
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    const a = invoiceRow(t.invoices, "INV-A")!.payments;
    const b = invoiceRow(t.invoices, "INV-B")!.payments;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: "P-14K", amount: "₹10,000", partOf: "₹14,000", forWords: "for INV-A · Oct 2025 – Mar 2026" });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ id: "P-14K", amount: "₹4,000", partOf: "₹14,000", forWords: "for INV-B · Apr 2026 – Sep 2026" });
    /* Payments tab: the receipt once, for both invoices, at its full amount */
    expect(t.payments).toHaveLength(1);
    expect(t.payments[0]).toMatchObject({ amount: "₹14,000", forWords: "for INV-A, INV-B" });
    /* the money under each invoice is what it shows as paid — no "no receipt" line added */
    expect([...a, ...b].some((p) => p.noReceipt)).toBe(false);
  });

  it("the invoices tab is newest first and holds only invoices; quotes tab only quotes", () => {
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    expect(t.invoices.map((r) => r.id)).toEqual(["INV-B", "INV-A"]);
    expect(t.quotes.map((r) => r.id)).toEqual(["Q-2"]);
    expect(t.quotes.every((r) => r.kind === "quote")).toBe(true);
  });

  it("known difference: today's drawerPaymentRows puts the receipt on the quote's first invoice and lists INV-A's ₹10,000 again as 'no receipt' — History lists it once", () => {
    const today = drawerPaymentRows(paid, docs);
    expect(today.map((r) => r.id)).toEqual(["P-14K", "invoice-paid:INV-A"]);
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    expect(t.payments.map((r) => r.id)).toEqual(["P-14K"]);
  });
});

describe("R-2836 review fixes: money is never listed twice", () => {
  it("an overpaid invoice: the extra ₹2,000 is in 'Not against an invoice yet' only — no 'no receipt' line for it", () => {
    const sub: Sub = { id: "S5", quote_id: "Q-5", renewal_quote_id: null, start_date: "2025-10-01" };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-5", invoice_id: "INV-5", amount: 10000 })],
      invoices: [inv({ id: "INV-5", quote_id: "Q-5", amount: 10000, paid_amount: 12000, status: "paid" })],
    });
    const paid = paidOf(sub, {
      linkedQuotes: [{ id: "Q-5", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-5" }],
      billings: [], invoices: [{ id: "INV-5", quote_id: "Q-5" }],
      payments: [pay({ id: "P-12K", amount: 12000, invoice_id: "INV-5" })],
    });
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    expect(invoiceRow(t.invoices, "INV-5")!.payments.map((p) => [p.id, p.amount, p.partOf])).toEqual([["P-12K", "₹10,000", "₹12,000"]]);
    expect(t.unlinked?.payments.map((p) => [p.id, p.amount])).toEqual([["P-12K", "₹2,000"]]);
    expect(t.payments.some((p) => p.noReceipt)).toBe(false);
  });

  it("a receipt on a part proforma whose invoice is known only through the billing row (R-2752) sits under that invoice", () => {
    const SUB = "S6";
    const sub: Sub = { id: SUB, quote_id: "Q-6", renewal_quote_id: null, start_date: "2026-10-01" };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-6" }), q({ id: "PI-6", subscription_billing_id: "B6", payment_status: "paid", created_date: "2026-10-01", created_at: "2026-10-01T05:00:00Z" })],
      billings: [{ id: "B6", subscription_id: SUB, invoice_id: "INV-6", term_start: "2026-10-01", period_index: 1, period_start: "2026-10-01", period_end: "2026-11-01" }],
      invoices: [inv({ id: "INV-6", invoice_date: "2026-10-02", amount: 3835, paid_amount: 3835, status: "paid" })],
    });
    const paid = paidOf(sub, {
      linkedQuotes: [{ id: "PI-6", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: null, subscription_billing_id: "B6" }],
      billings: [{ id: "B6", subscription_id: SUB, invoice_id: "INV-6" }], invoices: [],
      payments: [pay({ id: "P-UPI", amount: 3835, method: "upi", quote_id: "PI-6", received_at: "2026-10-12T05:00:00Z" })],
    });
    const t = historyTabs(docs, paid, { subQuoteId: null, todayIst: TODAY });
    expect(invoiceRow(t.invoices, "INV-6")?.payments.map((p) => [p.id, p.noReceipt])).toEqual([["P-UPI", false]]);
    expect(t.unlinked).toBeNull();
  });

  it("a receipt on an invoice that is not on this subscription's list still names it (never 'on quote' / blank)", () => {
    const sub: Sub = { id: "S7", quote_id: "Q-7", renewal_quote_id: null, start_date: "2025-10-01" };
    const docs = docsOf(sub, { quotes: [q({ id: "Q-7", payment_status: "partial" })] });
    const lp = paidOf(sub, {
      linkedQuotes: [{ id: "Q-7", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: null }],
      billings: [{ id: "B7", subscription_id: "S7", invoice_id: "INV-9" }], invoices: [],
      payments: [pay({ id: "P-9", invoice_id: "INV-9" })],
    });
    const t = historyTabs(docs, lp, { subQuoteId: sub.quote_id, todayIst: TODAY });
    expect(t.payments.map((p) => [p.id, p.forWords])).toEqual([["P-9", "for INV-9"]]);
  });
});

describe("R-2836 money not against an invoice yet", () => {
  const sub: Sub = { id: "S3", quote_id: "Q-OLD", renewal_quote_id: "Q-NEW", start_date: "2025-10-01" };
  const docs = docsOf(sub, {
    quotes: [
      q({ id: "Q-OLD", invoice_id: "INV-1" }),
      q({ id: "Q-NEW", status: "accepted", payment_status: "partial", created_at: "2026-10-20T05:00:00Z", created_date: "2026-10-20" }),
    ],
    invoices: [inv({ id: "INV-1", quote_id: "Q-OLD", status: "paid", paid_amount: 11800 })],
  });
  const paid = paidOf(sub, {
    linkedQuotes: [
      { id: "Q-OLD", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-1" },
      { id: "Q-NEW", renewal_subscription_id: "S3", add_seats_subscription_id: null, invoice_id: null },
    ],
    billings: [], invoices: [{ id: "INV-1", quote_id: "Q-OLD" }],
    payments: [
      pay({ id: "P-OLD", invoice_id: "INV-1", received_at: "2025-10-05T05:00:00Z" }),
      pay({ id: "P-ADV", amount: 5000, quote_id: "Q-NEW", received_at: "2026-10-25T05:00:00Z", method: "upi" }),
    ],
  });

  it("an advance on the renewal quote → ONE 'Not against an invoice yet' group at the top of All, naming the quote", () => {
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    expect(NOT_AGAINST_INVOICE).toBe("Not against an invoice yet");
    expect(t.unlinked?.title).toBe(NOT_AGAINST_INVOICE);
    expect(t.unlinked?.payments.map((p) => p.id)).toEqual(["P-ADV"]);
    expect(t.unlinked?.payments[0]).toMatchObject({ amount: "₹5,000", forWords: "on quote Q-NEW" });
    expect(t.all[0]).toBe(t.unlinked);
    expect(invoiceRow(t.all, "INV-1")!.payments.map((p) => p.id)).toEqual(["P-OLD"]);
    /* Invoices tab = invoices only; the advance is in Payments with the same words */
    expect(t.invoices.map((r) => r.kind as string)).not.toContain("unlinked");
    expect(t.payments.map((p) => [p.id, p.forWords])).toEqual([["P-ADV", "on quote Q-NEW"], ["P-OLD", "for INV-1"]]);
  });

  it("counts per tab equal today's drawerDocRows + drawerPaymentRows lengths", () => {
    const t = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
    const docRows = drawerDocRows(docs, TODAY);
    const payRows = drawerPaymentRows(paid, docs);
    expect(t.counts.quotes + t.counts.invoices).toBe(docRows.length);
    expect(t.counts.quotes).toBe(docRows.filter((r) => r.kind === "quote").length);
    expect(t.counts.invoices).toBe(docRows.filter((r) => r.kind === "invoice").length);
    expect(t.counts.payments).toBe(payRows.length);
    expect(t.counts.all).toBe(docRows.length + payRows.length);
    /* the doc rows are today's rows, same order */
    expect(t.all.filter((r) => r.kind !== "unlinked").map((r) => r.id)).toEqual(docRows.map((r) => r.id));
  });
});

describe("R-2836 edge cases", () => {
  it("nothing read yet → empty tabs, zero counts", () => {
    expect(historyTabs(undefined, undefined, { subQuoteId: null })).toMatchObject({ all: [], quotes: [], invoices: [], payments: [], unlinked: null, counts: { all: 0, quotes: 0, invoices: 0, payments: 0 } });
  });

  it("an instalment invoice billed from the subscription takes a payment on the subscription's quote (R-1564 link)", () => {
    const sub: Sub = { id: "S4", quote_id: "Q-I", renewal_quote_id: null, start_date: "2026-04-01" };
    const docs = docsOf(sub, {
      quotes: [q({ id: "Q-I", payment_status: "partial" })],
      billings: [{ id: "B1", subscription_id: "S4", invoice_id: "INV-P1", term_start: "2026-04-01", period_index: 0, period_start: "2026-04-01", period_end: "2026-05-01" }],
      invoices: [inv({ id: "INV-P1", invoice_date: "2026-04-01", amount: 3000, paid_amount: 3000, status: "paid" })],
    });
    const paid = paidOf(sub, {
      linkedQuotes: [{ id: "Q-I", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: null }],
      billings: [{ id: "B1", subscription_id: "S4", invoice_id: "INV-P1" }], invoices: [{ id: "INV-P1", quote_id: null }],
      payments: [pay({ id: "P-I", amount: 3000, quote_id: "Q-I", received_at: "2026-04-05T05:00:00Z" })],
    });
    const t = historyTabs(docs, paid, { subQuoteId: "Q-I", todayIst: TODAY });
    expect(invoiceRow(t.invoices, "INV-P1")?.payments.map((p) => [p.id, p.noReceipt])).toEqual([["P-I", false]]);
    expect(t.unlinked).toBeNull();
  });
});

describe("R-2836 wiring: one link rule", () => {
  it("drawer-history imports linkPaymentsToInvoices (no copy of the settle loop)", () => {
    const src = readFileSync("src/app/(app)/renewals/drawer-history.ts", "utf8");
    expect(src).toMatch(/import \{[^}]*linkPaymentsToInvoices[^}]*\} from "@\/components\/features\/customers\/invoice-payment-links"/);
    expect(src).not.toMatch(/room\.set\(/);
  });
});
