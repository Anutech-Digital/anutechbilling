/**
 * R-1708 (24 Oct 2026) — "money owed to us": ONE number, one rule, every screen.
 *
 * ─── WHAT WAS WRONG (billing audit, 20 Oct) ─────────────────────────────────
 * Three screens, three totals for the same question:
 *   · Payments → "Subscription dues" ₹2,29,172 — the sum of subscriptions.outstanding_amount
 *     (fetchOutstandingReceivables, lib/queries/payments.ts). It missed an invoice whose
 *     subscription says 0 (T-L3, ₹38,232) and an invoice with no subscription at all
 *     (T-L4, ₹1,29,600), and it counted a subscription's balance even when an invoice
 *     already asks for that money.
 *   · Invoices → "Outstanding" ₹3.9L — open invoices only (lib/invoices/kpis.ts invoiceBalance).
 *   · Payment Follow-up ₹3,97,004 — open invoices + subscription dues not yet invoiced
 *     (lib/queries/collections.ts buildCollectionRows).
 *
 * ─── THE ONE RULE (Payment Follow-up's, now shared) ─────────────────────────
 *   owed = Σ open invoices          invoiceAmountDue — pending / overdue, not written off,
 *                                    net_payable (after advances) − receipts since
 *        + Σ subscription dues      outstanding_amount > 0, not written off,
 *          NOT yet invoiced         whose quote has NO invoice (any status). Once the quote is
 *                                    invoiced the INVOICE is the claim; adding the subscription
 *                                    balance as well would ask for the same money twice.
 *
 * Invoices → Outstanding shows only the first part, labelled as such ("invoiced only").
 * Payments → the dues card heading shows the whole number with both parts; its rows stay
 * per subscription (that is where Record payment / Suspend / Write off act).
 *
 * Read-only: nothing here writes or "corrects" a stored balance.
 */
import { invoiceAmountDue, type InvoiceBalanceFields } from "./amount-due";

/** Statuses that are an issued, still-open claim. Draft (not issued) and void owe nothing. */
const OPEN_INVOICE = new Set(["pending", "overdue"]);

/** What one invoice still asks for — 0 unless it is an open claim (invoiceAmountDue). */
export function invoiceReceivable(inv: InvoiceBalanceFields): number {
  if (!OPEN_INVOICE.has((inv.status ?? "").toLowerCase())) return 0;
  return invoiceAmountDue(inv);
}

export interface SubscriptionDueFields {
  quote_id: string | null;
  outstanding_amount: number | null;
  written_off_at?: string | null;
}

/**
 * What one subscription still asks for that NO invoice asks for: its balance (whole rupees),
 * or 0 when written off or when its quote already has an invoice (the invoice is the claim).
 */
export function subscriptionReceivable(s: SubscriptionDueFields, invoicedQuoteIds: ReadonlySet<string>): number {
  if (s.written_off_at) return 0;
  const n = typeof s.outstanding_amount === "number" && Number.isFinite(s.outstanding_amount) ? s.outstanding_amount : 0;
  const due = Math.max(0, Math.round(n));
  if (due <= 0) return 0;
  if (s.quote_id && invoicedQuoteIds.has(s.quote_id)) return 0;
  return due;
}

export interface ReceivablesTotals {
  /** Open invoices — the same number as Invoices → Outstanding. */
  invoiced: number;
  /** Subscription dues no invoice asks for yet. */
  notYetInvoiced: number;
  /** invoiced + notYetInvoiced — the same number as Payment Follow-up's "₹ due". */
  total: number;
}

const paise = (v: number) => Math.round(v * 100);

/** Adds lines of either kind (Payment Follow-up's OwedItem shape) into the three totals. */
export function sumReceivables(items: Iterable<{ kind: "invoice" | "subscription"; amountDue: number }>): ReceivablesTotals {
  let inv = 0, sub = 0;
  for (const i of items) {
    if (i.kind === "invoice") inv += paise(i.amountDue);
    else sub += paise(i.amountDue);
  }
  return { invoiced: inv / 100, notYetInvoiced: sub / 100, total: (inv + sub) / 100 };
}

/** The totals straight from the rows read — the rule above, applied line by line. */
export function receivablesTotals(input: {
  invoices: readonly InvoiceBalanceFields[];
  subscriptions: readonly SubscriptionDueFields[];
  invoicedQuoteIds: ReadonlySet<string>;
}): ReceivablesTotals {
  return sumReceivables([
    ...input.invoices.map((i) => ({ kind: "invoice" as const, amountDue: invoiceReceivable(i) })),
    ...input.subscriptions.map((s) => ({ kind: "subscription" as const, amountDue: subscriptionReceivable(s, input.invoicedQuoteIds) })),
  ]);
}
