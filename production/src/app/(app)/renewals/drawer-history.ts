/**
 * R-2836 (Renewals history H1 — Pardeep 15 Nov: "quote/invoice/payment history ka pop-up"; audit
 * RENEWALS-AUDIT/audit-2026-11-15-history.md §5). The row drawer listed quotes + invoices in one long
 * list and every payment in a second list further down, and a payment never said which period it paid.
 * These are the pure rules for ONE History view with four tabs (the drawer UI is R-2838):
 *
 *   All       today's documents (drawerDocRows — same rows, words and order), each invoice carrying the
 *             payments that went to it, newest first, each "for <invoice> · <the period it covers>";
 *             money not against an invoice yet in ONE group at the top.
 *   Quotes    the quote rows only.          Invoices  the invoice rows only, payments nested.
 *   Payments  every receipt once at its full amount in ₹ (+ R-2818 "Paid on the invoice — no receipt"
 *             lines), newest first, saying which invoice(s) it paid.
 *
 * Which invoice a payment paid = the customer page's rule (components/features/customers/
 * invoice-payment-links.ts `linkPaymentsToInvoices`, R-2544) — imported, never copied: the payment's own
 * invoice, else its quote's invoices oldest first, each taking no more than the money it shows in
 * (`invoicePaidAmount`). An invoice whose money in is more than the receipts under it gets one "no
 * receipt" line for the gap (R-2818, USD Plan $500). Under an invoice every line is in the invoice's own
 * currency, so the lines add up to what it shows as paid.
 *
 * Counts equal today's drawerDocRows + drawerPaymentRows lengths — except when one quote has several
 * invoices: drawerPaymentRows puts a quote receipt on the quote's first invoice and lists the other
 * invoice's money again as "no receipt"; here it is settled oldest first, once. Tested in
 * drawer-history-h1.test.ts.
 */
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import {
  forInvoicesText, invoicePaidAmount, linkPaymentsToInvoices,
  type InstalmentLink, type LinkInvoice, type LinkPayment, type PaymentShare,
} from "@/components/features/customers/invoice-payment-links";
import { drawerDocRows, NO_RECEIPT_METHOD, type DrawerDocRow } from "./drawer";
import { docMoney, type LastDocs, type LastInvoice } from "./last-docs";
import { lastPaidSummary, type LastPaid, type PaidLine } from "./last-paid";

/** The one group of money received but not against an invoice yet (an advance, a quote not invoiced). */
export const NOT_AGAINST_INVOICE = "Not against an invoice yet";

export interface HistoryPaymentLine {
  /** The payment id; a no-receipt line is `invoice-paid:<invoice id>` (drawerPaymentRows' id). */
  id: string;
  /** "1 Nov 2026"; "" = a no-receipt line (no date known). */
  date: string;
  /** The money that went HERE (in the invoice's currency under an invoice) — a split payment shows each invoice its part. */
  amount: string;
  /** The payment's full amount in ₹ when this is only part of it; null = the whole payment. */
  partOf: string | null;
  method: string;
  /** "for INV-1 · Oct 2025 – Sep 2026" / "for INV-1, INV-2" / "on quote Q-7"; null = nothing to name. */
  forWords: string | null;
  /** "covers 2 subscriptions" when one payment was for several. */
  shared: string | null;
  /** R-2818: money on the invoice with no receipt row in the app. */
  noReceipt: boolean;
}

export type HistoryQuoteRow = DrawerDocRow & { kind: "quote" };
export type HistoryInvoiceRow = DrawerDocRow & { kind: "invoice"; payments: HistoryPaymentLine[] };
export interface HistoryUnlinkedGroup { kind: "unlinked"; id: "unlinked"; title: string; payments: HistoryPaymentLine[] }
export type HistoryRow = HistoryQuoteRow | HistoryInvoiceRow | HistoryUnlinkedGroup;

export type HistoryTab = "all" | "quotes" | "invoices" | "payments";
export interface HistoryTabs {
  all: HistoryRow[];
  quotes: HistoryQuoteRow[];
  invoices: HistoryInvoiceRow[];
  payments: HistoryPaymentLine[];
  unlinked: HistoryUnlinkedGroup | null;
  /** all = documents + payments. */
  counts: Record<HistoryTab, number>;
}

const toLinkInvoice = (i: LastInvoice): LinkInvoice => ({
  id: i.id, quote_id: i.sourceQuoteId, amount: i.amount, net_payable: i.netPayable, paid_amount: i.paidAmount,
  status: i.status, written_off_at: i.writtenOffAt, invoice_date: i.date ?? "", due_date: i.dueDate,
  adjusted_advances: i.adjustedAdvances, credit_noted: i.notes?.credit, debit_noted: i.notes?.debit,
});

/**
 * The drawer's History: four tabs + counts. `docs` = the drawer's `{ all: true }` documents, `paid` = its
 * `historySize: Infinity` payments (newest first). `subQuoteId` = subscriptions.quote_id: instalment
 * invoices billed from the subscription take payments on that quote (R-1564), as on the customer page.
 */
export function historyTabs(
  docs: LastDocs | undefined,
  paid: LastPaid | undefined,
  opts: { subQuoteId: string | null; todayIst?: string },
): HistoryTabs {
  const docRows = drawerDocRows(docs, opts.todayIst ?? istToday());
  const invoices = docs?.allInvoices ?? docs?.invoices ?? [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const lines = paid?.history ?? [];
  const lineById = new Map(lines.map((p) => [p.paymentId, p]));

  /* A billed part's proforma (R-2752) with no invoice_id: the ONE invoice billing the same part (both read
     their part from the same subscription_billings row in last-docs.ts). */
  const samePart = (a: LastInvoice["part"], b: LastInvoice["part"]) => !!a && !!b && a.start === b.start && a.endExclusive === b.endExclusive;
  const partInvoice = (part: LastInvoice["part"]) => {
    const hits = invoices.filter((i) => samePart(i.part, part));
    return hits.length === 1 ? hits[0].id : null;
  };
  const quotes = (docs?.allQuotes ?? []).map((q) => ({ id: q.id, invoice_id: q.invoice_id ?? partInvoice(q.part) }));
  const instalments: InstalmentLink[] = opts.subQuoteId
    ? invoices.filter((i) => i.part && !i.sourceQuoteId).map((i) => ({ invoice_id: i.id, quote_id: opts.subQuoteId }))
    : [];
  /* Quotes with an invoice on this list: a payment on one settles over them oldest first (invoice_id null). */
  const invoicedQuotes = new Set<string>([
    ...quotes.filter((q) => q.invoice_id && invById.has(q.invoice_id)).map((q) => q.id),
    ...invoices.flatMap((i) => (i.sourceQuoteId ? [i.sourceQuoteId] : [])),
    ...instalments.flatMap((l) => (l.quote_id ? [l.quote_id] : [])),
  ]);
  /* The payment's OWN invoice_id; a quote payment whose quote has no invoice here falls back to the invoice
     last-paid.ts found for it (e.g. a part proforma → its billing row's invoice, R-2752), as the drawer does today. */
  const toLinkPayment = (p: PaidLine): LinkPayment => ({
    id: p.paymentId, quote_id: p.quoteId, amount: p.amount, status: "received", received_at: p.receivedAt,
    invoice_id: p.ownInvoiceId ?? (p.quoteId && invoicedQuotes.has(p.quoteId) ? null : p.invoiceId),
  });
  const links = linkPaymentsToInvoices({ invoices: invoices.map(toLinkInvoice), payments: lines.map(toLinkPayment), quotes, instalments });

  const invoiceWords = (id: string) => {
    const period = invById.get(id)?.period;
    return period ? `${id} · ${period}` : id;
  };
  const receiptLine = (p: PaidLine, amount: string, partOf: string | null, forWords: string | null): HistoryPaymentLine => {
    const s = lastPaidSummary(p);
    return { id: p.paymentId, date: s.date, amount, partOf, method: s.method, forWords, shared: s.shared, noReceipt: false };
  };
  /* The link rule lists shares oldest payment first — reversed: newest first, like the drawer. */
  const shareLines = (shares: readonly PaymentShare[], money: (n: number) => string, forWords: (s: PaymentShare) => string | null) =>
    [...shares].reverse().flatMap((s) => {
      const p = lineById.get(s.paymentId);
      return p ? [receiptLine(p, money(s.amount), s.whole ? null : rupee(s.paymentAmount), forWords(s))] : [];
    });

  /* Under each invoice: its receipts (the link rule's shares), then the R-2818 gap line. */
  const gapLines: HistoryPaymentLine[] = [];
  const underInvoice = new Map<string, HistoryPaymentLine[]>();
  for (const inv of invoices) {
    const shares = links.byInvoice[inv.id] ?? [];
    const forWords = `for ${invoiceWords(inv.id)}`;
    const rows = shareLines(shares, (n) => docMoney(inv, n), () => forWords);
    const inReceipts = shares.reduce((t, s) => t + (s.counted ? s.amount : 0), 0);
    const gap = invoicePaidAmount(toLinkInvoice(inv)) - inReceipts;   // whole rupees; 0 for a draft / void invoice
    if (gap >= 1) {
      const line: HistoryPaymentLine = {
        id: `invoice-paid:${inv.id}`, date: "", amount: docMoney(inv, gap), partOf: null, method: NO_RECEIPT_METHOD,
        forWords, shared: null, noReceipt: true,
      };
      rows.push(line);
      gapLines.push(line);
    }
    underInvoice.set(inv.id, rows);
  }

  /* A receipt whose invoice is not on this subscription's list still names it (never an "advance"). */
  const outsideInvoice = (paymentId: string) => {
    const p = lineById.get(paymentId);
    return p?.invoiceId && !invById.has(p.invoiceId) ? p.invoiceId : null;
  };
  const unlinkedWords = (paymentId: string, quoteId: string | null) => {
    const named = outsideInvoice(paymentId);
    return named ? `for ${named}` : quoteId ? `on quote ${quoteId}` : null;
  };
  const unlinkedLines = shareLines(links.unlinked, rupee, (s) => unlinkedWords(s.paymentId, s.quoteId));
  const unlinked: HistoryUnlinkedGroup | null = unlinkedLines.length
    ? { kind: "unlinked", id: "unlinked", title: NOT_AGAINST_INVOICE, payments: unlinkedLines }
    : null;

  const quoteRows: HistoryQuoteRow[] = [];
  const invoiceRows: HistoryInvoiceRow[] = [];
  const all: HistoryRow[] = unlinked ? [unlinked] : [];
  for (const r of docRows) {
    const row: HistoryQuoteRow | HistoryInvoiceRow = r.kind === "invoice"
      ? { ...r, kind: "invoice", payments: underInvoice.get(r.id) ?? [] }
      : { ...r, kind: "quote" };
    if (row.kind === "invoice") invoiceRows.push(row); else quoteRows.push(row);
    all.push(row);
  }

  /* Payments tab: each receipt once at its full amount (paid.history is already newest first), then the no-receipt lines. */
  const forOf = (p: PaidLine): string | null => {
    const ids = links.forOf[p.paymentId] ?? [];
    if (ids.length === 1) return `for ${invoiceWords(ids[0])}`;
    if (ids.length > 1) return `for ${forInvoicesText(ids)}`;
    return unlinkedWords(p.paymentId, p.quoteId);
  };
  const payments: HistoryPaymentLine[] = [
    ...lines.map((p) => receiptLine(p, lastPaidSummary(p).amount, null, forOf(p))),
    ...gapLines,
  ];

  return {
    all, quotes: quoteRows, invoices: invoiceRows, payments, unlinked,
    counts: { all: docRows.length + payments.length, quotes: quoteRows.length, invoices: invoiceRows.length, payments: payments.length },
  };
}
