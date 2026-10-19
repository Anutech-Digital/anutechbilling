/**
 * R-1564 — Record payment on a subscription INSTALMENT invoice.
 *
 * An instalment invoice has no quote of its own (raise_subscription_billing leaves
 * invoices.quote_id NULL on purpose; the link is subscription_billings.invoice_id). The
 * invoice list's Record payment used to wait for "the quote whose invoice_id is this
 * invoice" and showed "Loading payment…" forever. These rules decide what the sheet opens
 * with, and what the result toast says about where the money went. The money itself moves
 * in ONE database call, record_instalment_payment (migration 20261018033137).
 */
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { rupee } from "@/lib/utils";

export interface InstalmentInvoiceFields {
  id: string;
  amount: number | null;
  net_payable?: number | null;
  paid_amount?: number | null;
  status?: string | null;
}

export type InvoicePaymentRoute =
  | { kind: "loading" }
  /** The lookup failed — say so, offer Retry (§24). */
  | { kind: "error"; title: string; detail: string }
  /** The invoice has its own quote — the quote-keyed sheet, as before. */
  | { kind: "quote" }
  /** A subscription instalment — the sheet for THIS invoice's own amount. */
  | { kind: "instalment"; quoteId: string; expected: number; alreadyReceived: number; due: number }
  /** Nothing to record against — say why and where to go. */
  | { kind: "none"; title: string; detail: string };

interface Lookup<T> { loading: boolean; failed: boolean; data: T | null | undefined }

/**
 * Which sheet an invoice's Record payment opens. Never "loading" once both lookups have
 * answered — that was the R-1564 hang (`isLoading || !quote`).
 */
export function invoicePaymentRoute(
  invoice: InstalmentInvoiceFields,
  quote: Lookup<{ id: string }>,
  link: Lookup<{ quoteId: string | null }>,
): InvoicePaymentRoute {
  if (quote.data?.id) return { kind: "quote" };
  if (link.data) {
    if (!link.data.quoteId) {
      return {
        kind: "none",
        title: "This instalment's subscription was not sold through a quote",
        detail: "A payment is recorded against the quote it was sold on. Open Subscriptions, link the subscription to its quote, then record the payment here.",
      };
    }
    const net = invoice.net_payable ?? invoice.amount ?? 0;
    return {
      kind: "instalment",
      quoteId: link.data.quoteId,
      expected: net,
      alreadyReceived: Math.max(0, invoice.paid_amount ?? 0),
      due: invoiceAmountDue(invoice),
    };
  }
  if (quote.loading || link.loading) return { kind: "loading" };
  if (quote.failed || link.failed) {
    return {
      kind: "error",
      title: "The payment details could not be loaded",
      detail: "Nothing was recorded. Check your connection and press Retry.",
    };
  }
  return {
    kind: "none",
    title: "This invoice is not linked to a quote or a subscription instalment",
    detail: "There is nothing to record the payment against here. A project invoice is paid from its project (Projects → the project → milestones).",
  };
}

/**
 * Multi-invoice payment lists ONE open instalment per subscription — the oldest (term, then
 * period). Two instalments of one subscription share its quote, and quote + reference is the
 * replay key, so record_multi_invoice_payment takes one per receipt. Rows are the
 * subscription_billings of OPEN invoices; returns their invoice ids.
 */
export function oldestInstalmentPerSubscription(
  rows: ReadonlyArray<{ invoice_id: string | null; subscription_id: string; term_start: string; period_index: number }>,
): string[] {
  const best = new Map<string, { invoice_id: string; term_start: string; period_index: number }>();
  for (const r of rows) {
    if (!r.invoice_id) continue;
    const cur = best.get(r.subscription_id);
    if (!cur || r.term_start < cur.term_start || (r.term_start === cur.term_start && r.period_index < cur.period_index)) {
      best.set(r.subscription_id, { invoice_id: r.invoice_id, term_start: r.term_start, period_index: r.period_index });
    }
  }
  return [...best.values()].map((b) => b.invoice_id);
}

/** What record_instalment_payment returns beyond record_desk_payment's own result. */
export interface InstalmentPaymentResult {
  invoice_id?: string;
  applied?: number;
  invoice_paid?: boolean;
  invoice_due_after?: number;
  also_applied?: Array<{ invoice_id: string; applied: number; invoice_paid: boolean }>;
  advance_left?: number;
}

/** Lines for the one result toast: where every rupee of this payment went. */
export function instalmentPaymentLines(r: InstalmentPaymentResult): string[] {
  const lines: string[] = [];
  const id = r.invoice_id ?? "this invoice";
  if (r.invoice_paid) lines.push(`${id} is now paid in full.`);
  else if ((r.invoice_due_after ?? 0) > 0) lines.push(`${id}: ${rupee(r.invoice_due_after ?? 0)} still due.`);
  for (const o of r.also_applied ?? []) {
    lines.push(`${rupee(o.applied)} more went to ${o.invoice_id}${o.invoice_paid ? " — paid in full" : ""}.`);
  }
  if ((r.advance_left ?? 0) > 0) {
    lines.push(`${rupee(r.advance_left ?? 0)} is kept for this subscription — it is adjusted on the next instalment invoice automatically.`);
  }
  return lines;
}
