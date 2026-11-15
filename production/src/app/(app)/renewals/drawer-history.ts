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
 *   Payments  every receipt once at its full amount (+ R-2818 "Paid on the invoice — no receipt" lines),
 *             newest first, saying which invoice(s) it paid.
 *
 * Which invoice a payment paid = the customer page's rule (components/features/customers/
 * invoice-payment-links.ts `linkPaymentsToInvoices`, R-2544) — imported, never copied: the payment's own
 * invoice, else its quote's invoices oldest first, each taking no more than the money it shows in. An
 * invoice whose money in is more than the receipts under it gets one "no receipt" line for the gap, in
 * its own currency (R-2818, USD Plan $500). Tested in drawer-history-h1.test.ts.
 */
import { rupee } from "@/lib/utils";
import {
  forInvoicesText, linkPaymentsToInvoices, type InstalmentLink, type LinkInvoice, type LinkPayment, type PaymentShare,
} from "@/components/features/customers/invoice-payment-links";
import { drawerDocRows, NO_RECEIPT_METHOD, type DrawerDocRow } from "./drawer";
import { docMoney, type LastDocs, type LastInvoice } from "./last-docs";
import { lastPaidSummary, type LastPaid, type PaidLine } from "./last-paid";
import { istToday } from "@/lib/dates/ist";

/** The one group of money received but not against an invoice yet (an advance, a quote not invoiced). */
export const NOT_AGAINST_INVOICE = "Not against an invoice yet";

export interface HistoryPaymentLine {
  /** The payment id; a no-receipt line is `invoice-paid:<invoice id>` (drawerPaymentRows' id). */
  id: string;
  /** "01 Nov 2026"; "" = a no-receipt line (no date known). */
  date: string;
  /** The money that went HERE — a payment split over two invoices shows each invoice its part. */
  amount: string;
  /** The payment's full amount when this is only part of it; null = the whole payment. */
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
  /** all = documents + payments (= drawerDocRows + drawerPaymentRows lengths). */
  counts: Record<HistoryTab, number>;
}

const NOT_ISSUED_INVOICE = new Set(["void", "cancelled", "draft"]);

const toLinkInvoice = (i: LastInvoice): LinkInvoice => ({
  id: i.id, quote_id: i.sourceQuoteId, amount: i.amount, net_payable: i.netPayable, paid_amount: i.paidAmount,
  status: i.status, written_off_at: i.writtenOffAt, invoice_date: i.date ?? "", due_date: i.dueDate,
  adjusted_advances: i.adjustedAdvances, credit_noted: i.notes?.credit, debit_noted: i.notes?.debit,
});

/* A PaidLine's invoiceId may be worked out from its quote (last-paid.ts) — the link rule needs the
   payment's OWN invoice_id, so a quote payment settles over the quote's invoices oldest first. */
const toLinkPayment = (p: PaidLine): LinkPayment => ({
  id: p.paymentId, quote_id: p.quoteId, amount: p.amount, status: "received", received_at: p.receivedAt,
  invoice_id: p.ownInvoiceId !== undefined ? p.ownInvoiceId : p.quoteId ? null : p.invoiceId,
});

const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

/**
 * The drawer's History: four tabs + counts. `docs` = the drawer's `{ all: true }` documents, `paid` = its
 * `historySize: Infinity` payments. `subQuoteId` (subscriptions.quote_id) links instalment invoices billed
 * from the subscription to payments on that quote (R-1564), as the customer page does.
 */
export function historyTabs(
  docs: LastDocs | undefined,
  paid: LastPaid | undefined,
  opts: { todayIst?: string; subQuoteId?: string | null } = {},
): HistoryTabs {
  const docRows = drawerDocRows(docs, opts.todayIst ?? istToday());
  const invoices = docs?.allInvoices ?? docs?.invoices ?? [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const lines = paid?.history ?? [];
  const lineById = new Map(lines.map((p) => [p.paymentId, p]));

  const instalments: InstalmentLink[] = opts.subQuoteId
    ? invoices.filter((i) => i.part && !i.sourceQuoteId).map((i) => ({ invoice_id: i.id, quote_id: opts.subQuoteId ?? null }))
    : [];
  const links = linkPaymentsToInvoices({
    invoices: invoices.map(toLinkInvoice),
    payments: lines.map(toLinkPayment),
    quotes: (docs?.allQuotes ?? []).map((q) => ({ id: q.id, invoice_id: q.invoice_id })),
    instalments,
  });

  const invoiceWords = (id: string) => {
    const period = invById.get(id)?.period;
    return period ? `${id} · ${period}` : id;
  };
  const forOf = (paymentId: string, quoteId: string | null): string | null => {
    const ids = links.forOf[paymentId] ?? [];
    if (ids.length === 1) return `for ${invoiceWords(ids[0])}`;
    if (ids.length > 1) return `for ${forInvoicesText(ids)}`;
    return quoteId ? `on quote ${quoteId}` : null;
  };
  const receiptLine = (p: PaidLine, share: PaymentShare | null, forWords: string | null): HistoryPaymentLine & { at: string } => {
    const s = lastPaidSummary(p);
    const split = share != null && !share.whole;
    return {
      id: p.paymentId, date: s.date, amount: split ? rupee(share.amount) : s.amount, partOf: split ? s.amount : null,
      method: s.method, forWords, shared: s.shared, noReceipt: false, at: p.receivedAt,
    };
  };
  const strip = ({ at: _at, ...line }: HistoryPaymentLine & { at: string }): HistoryPaymentLine => line;
  const sharesToLines = (shares: readonly PaymentShare[], forWords: (s: PaymentShare) => string | null) =>
    shares
      .map((s) => ({ s, p: lineById.get(s.paymentId) }))
      .filter((x): x is { s: PaymentShare; p: PaidLine } => !!x.p)
      .map(({ s, p }) => receiptLine(p, s, forWords(s)));

  /* Under each invoice: its receipts (the link rule's shares), then the R-2818 gap line. */
  const gapLines: HistoryPaymentLine[] = [];
  const underInvoice = new Map<string, HistoryPaymentLine[]>();
  for (const inv of invoices) {
    const shares = links.byInvoice[inv.id] ?? [];
    const rows = sharesToLines(shares, () => `for ${invoiceWords(inv.id)}`).sort(newestFirst).map(strip);
    if (!NOT_ISSUED_INVOICE.has(inv.status)) {
      const inReceipts = shares.reduce((t, s) => t + (s.counted ? s.amount : 0), 0);
      const gap = Math.round((inv.paidAmount - inReceipts) * 100) / 100;
      if (gap >= 1) {   // under ₹1 is rounding (drawerPaymentRows' rule)
        const line: HistoryPaymentLine = {
          id: `invoice-paid:${inv.id}`, date: "", amount: docMoney(inv, gap), partOf: null, method: NO_RECEIPT_METHOD,
          forWords: `for ${invoiceWords(inv.id)}`, shared: null, noReceipt: true,
        };
        rows.push(line);
        gapLines.push(line);
      }
    }
    underInvoice.set(inv.id, rows);
  }

  const unlinkedLines = sharesToLines(links.unlinked, (s) => (s.quoteId ? `on quote ${s.quoteId}` : null)).sort(newestFirst).map(strip);
  const unlinked: HistoryUnlinkedGroup | null = unlinkedLines.length
    ? { kind: "unlinked", id: "unlinked", title: NOT_AGAINST_INVOICE, payments: unlinkedLines }
    : null;

  const quotes: HistoryQuoteRow[] = [];
  const invoiceRows: HistoryInvoiceRow[] = [];
  const all: HistoryRow[] = unlinked ? [unlinked] : [];
  for (const r of docRows) {
    if (r.kind === "invoice") {
      const row: HistoryInvoiceRow = { ...r, kind: "invoice", payments: underInvoice.get(r.id) ?? [] };
      invoiceRows.push(row);
      all.push(row);
    } else {
      const row: HistoryQuoteRow = { ...r, kind: "quote" };
      quotes.push(row);
      all.push(row);
    }
  }

  /* Payments tab: each receipt once, at its full amount, then the no-receipt lines (as drawerPaymentRows). */
  const payments: HistoryPaymentLine[] = [
    ...[...lines].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.paymentId.localeCompare(a.paymentId))
      .map((p) => strip(receiptLine(p, null, forOf(p.paymentId, p.quoteId)))),
    ...gapLines,
  ];

  return {
    all, quotes, invoices: invoiceRows, payments, unlinked,
    counts: { all: docRows.length + payments.length, quotes: quotes.length, invoices: invoiceRows.length, payments: payments.length },
  };
}
