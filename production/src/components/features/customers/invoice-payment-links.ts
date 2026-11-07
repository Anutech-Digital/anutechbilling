/**
 * R-2544 (Pardeep, 6 Nov 2026 — "payment jis invoice ke related hai uski under show honi chahiye").
 * Customer → Transactions listed every invoice and then every payment as flat rows; nobody could
 * see which payment paid which invoice. This works out, for each of the customer's payments, the
 * invoice(s) it paid — with the SAME links the database uses to fill invoices.paid_amount:
 *
 *   1. payments.invoice_id — a receipt on an invoice with no quote: a Zoho opening invoice (R-1739)
 *      or a Zoho FY sale (R-2501 receipts import, R-2542 Record payment / bank Reconcile);
 *   2. payments.quote_id → that quote's invoice(s): quotes.invoice_id (record_payment), every invoice
 *      with invoices.quote_id = the quote (R-2092 one invoice per quote-period) and the subscription
 *      instalments billed from it (subscription_billings.invoice_id → subscriptions.quote_id, R-1564).
 *      A multi-invoice receipt (R-1525) is already one payments row per invoice, so it appears under
 *      each invoice with the amount that invoice got.
 *
 * When a quote has several invoices the database settles the oldest first; so does this, and no
 * invoice takes more than the money it shows in (invoicePaidAmount = invoiceMoneyIn, R-1709: paid_amount
 * + advances adjusted at issue, capped at the value after credit/debit notes). What is left over — money on a quote
 * not yet invoiced, an advance holder (R-1863), an overpayment kept as credit — is "unlinked": the
 * "Advance / not yet against an invoice" group. Result: the rows under an invoice add up to its
 * paid amount, the same number the invoice page and its status use.
 */
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { invoiceMoneyIn, invoicePaymentState } from "@/lib/invoices/payment-state";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import { rupee } from "@/lib/utils";

export interface LinkInvoice {
  id: string;
  quote_id: string | null;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  written_off_at: string | null;
  invoice_date: string;
  due_date: string | null;
  /** invoices.adjusted_advances — advances folded in at issue. */
  adjusted_advances?: unknown;
  /** Sums of this invoice's credit / debit notes (₹); undefined = not read. */
  credit_noted?: number | null;
  debit_noted?: number | null;
}
export interface LinkPayment {
  id: string;
  quote_id: string | null;
  invoice_id?: string | null;
  amount: number;
  status: string;
  received_at: string;
  refunded_at?: string | null;
  reference?: string | null;
}
export interface LinkQuote { id: string; invoice_id?: string | null }
/** An instalment invoice billed from a subscription, with that subscription's quote. */
export interface InstalmentLink { invoice_id: string; quote_id: string | null }

export interface PaymentShare {
  paymentId: string;
  /** null = not against an invoice (the advance group). */
  invoiceId: string | null;
  quoteId: string | null;
  /** The part of the payment that went here (whole rupees, TDS included like payments.amount). */
  amount: number;
  /** The payment's full amount — differs from `amount` when one payment covers several invoices. */
  paymentAmount: number;
  whole: boolean;
  /** false for a refunded / not-received payment: shown, but adds nothing to what is paid. */
  counted: boolean;
}

export interface PaymentLinks {
  byInvoice: Record<string, PaymentShare[]>;
  unlinked: PaymentShare[];
  /** Payment id → the invoices it paid (empty = advance / not against an invoice). */
  forOf: Record<string, string[]>;
}

/** Money in on the invoice — the app's one rule (lib/invoices/payment-state.ts), whole rupees. */
export function invoicePaidAmount(inv: LinkInvoice): number {
  return Math.max(0, Math.round(invoiceMoneyIn(inv)));
}

function payDate(p: LinkPayment): string {
  return p.received_at ?? "";
}
const byDateThenId = <T,>(date: (x: T) => string, id: (x: T) => string) => (a: T, b: T) =>
  date(a).localeCompare(date(b)) || id(a).localeCompare(id(b));

export function linkPaymentsToInvoices(input: {
  invoices: readonly LinkInvoice[];
  payments: readonly LinkPayment[];
  quotes: readonly LinkQuote[];
  instalments: readonly InstalmentLink[];
}): PaymentLinks {
  const invById = new Map(input.invoices.map((i) => [i.id, i]));
  // Quote → its invoices, oldest first (the order the database settles them).
  const quoteInvoices = new Map<string, Set<string>>();
  const addQ = (q: string | null | undefined, invId: string | null | undefined) => {
    if (!q || !invId || !invById.has(invId)) return;
    (quoteInvoices.get(q) ?? quoteInvoices.set(q, new Set()).get(q)!).add(invId);
  };
  for (const q of input.quotes) addQ(q.id, q.invoice_id);
  for (const i of input.invoices) addQ(i.quote_id, i.id);
  for (const l of input.instalments) addQ(l.quote_id, l.invoice_id);
  const oldestFirst = byDateThenId<LinkInvoice>((i) => i.invoice_date ?? "", (i) => i.id);
  const candidates = (p: LinkPayment): LinkInvoice[] => {
    if (p.invoice_id && invById.has(p.invoice_id)) return [invById.get(p.invoice_id)!];
    const ids = p.quote_id ? quoteInvoices.get(p.quote_id) : undefined;
    return ids ? [...ids].map((id) => invById.get(id)!).sort(oldestFirst) : [];
  };

  const room = new Map(input.invoices.map((i) => [i.id, invoicePaidAmount(i)]));
  const out: PaymentLinks = { byInvoice: {}, unlinked: [], forOf: {} };
  const put = (s: PaymentShare) => {
    if (s.invoiceId) (out.byInvoice[s.invoiceId] ??= []).push(s);
    else out.unlinked.push(s);
  };

  for (const p of [...input.payments].sort(byDateThenId<LinkPayment>(payDate, (x) => x.id))) {
    const amount = Math.max(0, Math.round(p.amount ?? 0));
    const cands = candidates(p);
    const base = { paymentId: p.id, quoteId: p.quote_id ?? null, paymentAmount: amount };
    out.forOf[p.id] = [];
    if (p.status !== "received") {
      // Shown where it belongs, never counted.
      const invoiceId = cands[0]?.id ?? null;
      if (invoiceId) out.forOf[p.id].push(invoiceId);
      put({ ...base, invoiceId, amount, whole: true, counted: false });
      continue;
    }
    let left = amount;
    const parts: { invoiceId: string | null; amount: number }[] = [];
    for (const c of cands) {
      if (left <= 0) break;
      const take = Math.min(left, room.get(c.id) ?? 0);
      if (take <= 0) continue;
      room.set(c.id, (room.get(c.id) ?? 0) - take);
      parts.push({ invoiceId: c.id, amount: take });
      left -= take;
    }
    if (left > 0 || parts.length === 0) parts.push({ invoiceId: null, amount: left });
    const whole = parts.length === 1;
    for (const part of parts) {
      if (part.invoiceId) out.forOf[p.id].push(part.invoiceId);
      put({ ...base, invoiceId: part.invoiceId, amount: part.amount, whole, counted: true });
    }
  }
  return out;
}

export interface InvoiceStatusView { label: string; tone: "paid" | "part" | "overdue" | "muted" | "open" }

/** The invoice row's status on Transactions: Paid / Part-paid (₹X due) / Overdue — one place for the due. */
export function invoiceStatusView(inv: LinkInvoice, todayIst: string): InvoiceStatusView {
  // State from invoicePaymentState (R-1709), overdue from invoiceIsOverdue, due from invoiceAmountDue —
  // the same three the Invoices list uses, so the two screens never disagree.
  const state = invoicePaymentState(inv);
  if (state === "void") return { label: "Void", tone: "muted" };
  if (state === "draft") return { label: "Draft", tone: "muted" };
  if (state === "credited") return { label: "Credited", tone: "muted" };
  if (state === "written-off") return { label: "Written off", tone: "muted" };
  const due = invoiceAmountDue(inv);
  if (state === "paid" || due <= 0) return { label: "Paid", tone: "paid" };
  const part = state === "partial";
  if (invoiceIsOverdue(inv, todayIst)) return { label: part ? `Overdue (${rupee(due)} due)` : "Overdue", tone: "overdue" };
  if (part) return { label: `Part-paid (${rupee(due)} due)`, tone: "part" };
  return { label: "Unpaid", tone: "open" };
}

/** The Payments tab's "For" cell: invoice numbers (two, then +N), or "Advance". */
export function forInvoicesText(invoiceIds: readonly string[] | undefined): string {
  const ids = invoiceIds ?? [];
  if (ids.length === 0) return "Advance";
  return ids.length <= 2 ? ids.join(", ") : `${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
}
