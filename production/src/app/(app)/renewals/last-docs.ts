/**
 * R-2728 (Pardeep, 13 Nov 2026 — Pratik's daily /renewals): "renewal list me last quote aur
 * invoice bhi show kare jo use bheja gaya tha clickable link ke saath … quote sent hone ke baad
 * wo yaha se gayab na ho balki renewal quote sent ki list me show kare saath me expired in days".
 *
 * Audit (card R-2728 `design`): "Bill next part" (R-2095) rolls renewal_date to the next term and
 * sets renewal_state 'renewed' the moment the part proforma is RAISED — unpaid — so the row left
 * Overdue for a far tab and read "Renewed"; a sent renewal quote left no state on the row at all.
 *
 * Per subscription, from one batched read (last-docs-data.ts):
 *   quote   the newest quote SENT to the customer for it — its own quote (subscriptions.quote_id),
 *           its renewal quotes (renewal_quote_id / quotes.renewal_subscription_id), add-seats
 *           quotes and its part proformas (quotes.subscription_billing_id → subscription_billings);
 *           drafts, cancelled / void and revised-away (superseded) quotes are not "sent".
 *   invoice the newest invoice raised from one of those quotes or for one of its billed parts
 *           (void / cancelled left out) — paid / part paid / unpaid.
 *   sent    the renewal waiting on the customer: the linked renewal quote sent / viewed / accepted
 *           and not paid, or the renewal's part proforma (part 1 of the newest term — not the first
 *           term, which is the original sale) sent and not paid. Paid → null (the row is Renewed
 *           as before). The row status "Renewal quote sent" comes from this (queue.ts).
 * Display only — no money rule changes. Pure — tested in last-docs-r2728.test.ts.
 */
import { rupee } from "@/lib/utils";
import { shownQuoteStatus, validityDaysLeft } from "@/lib/quotes/quote-expiry";

export interface DocQuote {
  id: string;
  status: string;
  payment_status: string | null;
  created_at: string;
  created_date: string | null;
  expires_date: string | null;
  invoice_id: string | null;
  renewal_subscription_id: string | null;
  add_seats_subscription_id: string | null;
  subscription_billing_id: string | null;
  superseded_by: string | null;
}

export interface DocBilling {
  id: string;
  subscription_id: string;
  invoice_id: string | null;
  term_start: string | null;
  period_index: number | null;
  /** When the part is due (R-2044 due_on), else its period start — the part row's due words. */
  due_on?: string | null;
  period_start?: string | null;
}

export interface DocInvoice {
  id: string;
  quote_id: string | null;
  invoice_date: string | null;
  status: string;
  amount: number | null;
  paid_amount: number | null;
  currency: string | null;
  created_at: string | null;
}

export interface LastDocsInput {
  subs: ReadonlyArray<{ id: string; quote_id: string | null; renewal_quote_id: string | null; start_date: string | null }>;
  quotes: readonly DocQuote[];
  billings: readonly DocBilling[];
  invoices: readonly DocInvoice[];
}

export interface LastQuote {
  id: string;
  /** YYYY-MM-DD — the quote's date. */
  date: string;
  status: string;
  payment_status: string | null;
  expires_date: string | null;
  invoice_id: string | null;
}

export interface LastInvoice {
  id: string;
  date: string | null;
  status: string;
  /** Rupees incl. GST, as stored. */
  amount: number;
  paidAmount: number;
  currency: string | null;
}

export interface SentRenewal {
  quoteId: string;
  /** renewal = the whole-term renewal quote; part = the renewal's part proforma (Bill next part). */
  kind: "renewal" | "part";
  /** The quote's validity (quotes.expires_date); null = none set (part proformas have none). */
  expiresDate: string | null;
  status: string;
  /** part: the date the billed part is due (Bill next part moved renewal_date a term on, so it is not that). */
  dueDate?: string | null;
}

export interface LastDocs {
  quote: LastQuote | null;
  invoice: LastInvoice | null;
  sent: SentRenewal | null;
}

/** Never sent to the customer, or taken back. */
const NOT_SENT = new Set(["draft", "cancelled", "void"]);
/** Never issued (draft) or taken back — not "sent" to the customer. */
const DEAD_INVOICE = new Set(["void", "cancelled", "draft"]);
/** Waiting on the customer (or accepted, money not in yet). */
const OPEN_STATUS = new Set(["sent", "viewed", "accepted"]);
const UNPAID = new Set(["none", "awaiting", "partial"]);

const isSent = (q: DocQuote) => !NOT_SENT.has(q.status) && !q.superseded_by;
const isOpenUnpaid = (q: DocQuote) => isSent(q) && OPEN_STATUS.has(q.status) && UNPAID.has(q.payment_status ?? "none");

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  const s = m.get(k);
  if (s) s.add(v); else m.set(k, new Set([v]));
}

const newer = (a: { at: string; id: string }, b: { at: string; id: string }) => a.at > b.at || (a.at === b.at && a.id > b.id);

export function lastDocsBySubscription(input: LastDocsInput): Map<string, LastDocs> {
  const subIds = new Set(input.subs.map((s) => s.id));
  const billingById = new Map(input.billings.map((b) => [b.id, b]));
  /* quote id → the listed subscriptions it belongs to */
  const quoteSubs = new Map<string, Set<string>>();
  for (const s of input.subs) {
    if (s.quote_id) add(quoteSubs, s.quote_id, s.id);
    if (s.renewal_quote_id) add(quoteSubs, s.renewal_quote_id, s.id);
  }
  for (const q of input.quotes) {
    for (const sid of [q.renewal_subscription_id, q.add_seats_subscription_id, billingById.get(q.subscription_billing_id ?? "")?.subscription_id]) {
      if (sid && subIds.has(sid)) add(quoteSubs, q.id, sid);
    }
  }
  /* invoice id → subscriptions: raised from a linked quote (either side of the link) or for a billed part */
  const invoiceSubs = new Map<string, Set<string>>();
  const quoteById = new Map(input.quotes.map((q) => [q.id, q]));
  for (const q of input.quotes) if (q.invoice_id) for (const sid of quoteSubs.get(q.id) ?? []) add(invoiceSubs, q.invoice_id, sid);
  for (const i of input.invoices) if (i.quote_id) for (const sid of quoteSubs.get(i.quote_id) ?? []) add(invoiceSubs, i.id, sid);
  for (const b of input.billings) if (b.invoice_id && subIds.has(b.subscription_id)) add(invoiceSubs, b.invoice_id, b.subscription_id);

  const out = new Map<string, LastDocs>();
  for (const s of input.subs) out.set(s.id, { quote: null, invoice: null, sent: null });

  const bestQuote = new Map<string, DocQuote>();
  for (const q of quoteById.values()) {
    if (!isSent(q)) continue;
    for (const sid of quoteSubs.get(q.id) ?? []) {
      const cur = bestQuote.get(sid);
      if (!cur || newer({ at: q.created_at, id: q.id }, { at: cur.created_at, id: cur.id })) bestQuote.set(sid, q);
    }
  }
  for (const [sid, q] of bestQuote) {
    out.get(sid)!.quote = {
      id: q.id, date: (q.created_date ?? q.created_at).slice(0, 10), status: q.status,
      payment_status: q.payment_status, expires_date: q.expires_date, invoice_id: q.invoice_id,
    };
  }

  const bestInvoice = new Map<string, DocInvoice>();
  const seenInv = new Set<string>();
  for (const i of input.invoices) {
    if (seenInv.has(i.id) || DEAD_INVOICE.has(i.status)) continue;
    seenInv.add(i.id);
    const at = `${i.invoice_date ?? ""}|${i.created_at ?? ""}`;
    for (const sid of invoiceSubs.get(i.id) ?? []) {
      const cur = bestInvoice.get(sid);
      if (!cur || newer({ at, id: i.id }, { at: `${cur.invoice_date ?? ""}|${cur.created_at ?? ""}`, id: cur.id })) bestInvoice.set(sid, i);
    }
  }
  for (const [sid, i] of bestInvoice) {
    out.get(sid)!.invoice = {
      id: i.id, date: i.invoice_date, status: i.status, amount: Number(i.amount) || 0,
      paidAmount: Number(i.paid_amount) || 0, currency: i.currency,
    };
  }

  /* The newest term each subscription has billing rows for — its renewal part lives there — and that
     term's FIRST part (period_index restarts each term: 1 on today's rows, 0 on a few older ones). */
  const newestTerm = new Map<string, string>();
  for (const b of input.billings) {
    if (!b.term_start) continue;
    const cur = newestTerm.get(b.subscription_id);
    if (!cur || b.term_start > cur) newestTerm.set(b.subscription_id, b.term_start);
  }
  const firstIndex = new Map<string, number>();
  for (const b of input.billings) {
    if (!b.term_start || b.term_start !== newestTerm.get(b.subscription_id)) continue;
    const i = b.period_index ?? 0;
    const cur = firstIndex.get(b.subscription_id);
    if (cur === undefined || i < cur) firstIndex.set(b.subscription_id, i);
  }
  for (const s of input.subs) {
    const d = out.get(s.id)!;
    const ren = s.renewal_quote_id ? quoteById.get(s.renewal_quote_id) : undefined;
    if (ren && isOpenUnpaid(ren)) {
      d.sent = { quoteId: ren.id, kind: "renewal", expiresDate: ren.expires_date, status: ren.status };
      continue;
    }
    const term = newestTerm.get(s.id);
    if (!term || (s.start_date && term <= s.start_date.slice(0, 10))) continue;
    let part: DocQuote | null = null;
    let partBill: DocBilling | null = null;
    for (const q of input.quotes) {
      const b = billingById.get(q.subscription_billing_id ?? "");
      if (!b || b.subscription_id !== s.id || b.term_start !== term || (b.period_index ?? 0) !== firstIndex.get(s.id) || !isOpenUnpaid(q)) continue;
      if (!part || newer({ at: q.created_at, id: q.id }, { at: part.created_at, id: part.id })) { part = q; partBill = b; }
    }
    if (part) {
      d.sent = {
        quoteId: part.id, kind: "part", expiresDate: part.expires_date, status: part.status,
        dueDate: partBill?.due_on ?? partBill?.period_start ?? partBill?.term_start ?? null,
      };
    }
  }
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Whole calendar days from one IST date (YYYY-MM-DD) to another; negative = in the past. */
export function daysBetweenIst(fromIst: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIst.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** The quote's validity in IST calendar days (valid through its last day, R-1679). */
export function quoteExpiryText(expiresDate: string | null | undefined, todayIst: string): string {
  const left = validityDaysLeft(expiresDate, todayIst);
  if (left == null) return "No expiry set";
  const d = left - 1;
  if (d > 0) return `Expires in ${plural(d, "day")}`;
  if (d === 0) return "Expires today";
  return `Expired ${plural(-d, "day")} ago`;
}

/** The renewal date's due words — ONE wording, used by the status chip too (queue.ts renewalRowStatus). */
export function renewalDueText(daysUntil: number): string {
  if (daysUntil < 0) return `Overdue ${Math.abs(daysUntil)}d`;
  if (daysUntil === 0) return "Due today";
  return `Due in ${daysUntil}d`;
}

/**
 * Sent / Viewed / Accepted / Part paid / Paid / Invoiced / Expired (a waiting quote past its date,
 * R-1679) / Rejected. "invoiced" is NOT paid (an invoice can be raised on an accepted, unpaid quote,
 * R-2404) — the invoice line says whether it is paid.
 */
export function quoteStateLabel(
  q: { status: string; payment_status: string | null; expires_date: string | null; invoice_id: string | null },
  todayIst: string,
): string {
  if (q.payment_status === "received") return "Paid";
  if (q.payment_status === "invoiced") return "Invoiced";
  if (q.payment_status === "partial") return "Part paid";
  const shown = shownQuoteStatus({ status: q.status, expires_date: q.expires_date, payment_status: q.payment_status, invoice_id: q.invoice_id }, todayIst);
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

/** "Paid" / "Part paid · ₹x due" / "Unpaid · ₹x" (no ₹ figure for a foreign-currency invoice). */
export function invoicePaidText(i: LastInvoice): string {
  const inr = !i.currency || i.currency === "INR";
  const due = Math.max(0, Math.round(i.amount - i.paidAmount));
  if (i.status === "paid" || (i.amount > 0 && due === 0)) return "Paid";
  if (i.paidAmount > 0) return inr ? `Part paid · ${rupee(due)} due` : "Part paid";
  return inr ? `Unpaid · ${rupee(Math.round(i.amount))}` : "Unpaid";
}
