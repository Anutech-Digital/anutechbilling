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
 *
 * R-2737 (Pardeep, 13 Nov 2026): "last invoice ke status bhi show hona chahiye, uska subscription
 * period bhi show hona chahiye".
 *   status  invoiceStatusWords — the /invoices rules (overdue.ts: IST, due date, net_payable;
 *           payment-state.ts: part paid, credited, written off). The newest invoice is shown even
 *           when void ("Cancelled", greyed) — it used to be skipped, so an older "Paid" one showed.
 *   period  the SAME source the invoice paper prints: a billed part → its subscription_billings
 *           period (period_end exclusive; the proforma prints period_end − 1); a whole-quote
 *           invoice → its quote lines' "Subscription period" (lineServicePeriod, R-1764 — the
 *           quote's renewal_term_date + extension_months, or the line's start + term). Never a
 *           recomputed next term: no stored source → no period. Tested in last-docs-r2737.test.ts.
 *
 * R-2748 (Pardeep, 13 Nov 2026): "renewal page par last two invoices and related quotes with
 * payment status show hone chahiye". `invoices` = up to TWO linked invoices, newest first: the
 * R-2737 pick (`invoice` — never a void hiding money owed) and the newest other one; each carries
 * the quote it came from (`sourceQuote`). Tested in last-docs-r2748.test.ts.
 *
 * R-2740 (row drawer): `{ all: true }` also returns EVERY linked quote — drafts, cancelled and
 * revised-away ones too, marked, never hidden — and every issued linked invoice (void too), newest
 * first, as `allQuotes` / `allInvoices`; same links, words and periods as the row. Tested in
 * drawer-r2740.test.ts.
 */
import { rupee } from "@/lib/utils";
import { shownQuoteStatus, validityDaysLeft } from "@/lib/quotes/quote-expiry";
import { lineServicePeriod, quoteLinePeriodContext, addDaysIso, periodDate, type LinePeriodLine } from "@/lib/quotes/service-period";
import { invoiceIsOverdue, invoiceOverdueDays } from "@/lib/invoices/overdue";
import { invoicePaymentState, fullyCredited } from "@/lib/invoices/payment-state";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { foreignEquivalent, formatForeign, isForeignCurrency } from "@/lib/currency";
import type { NoteTotals } from "@/lib/invoices/note-totals";

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
  /** R-2740: the quote this one revises (quotes.revision_of); absent = not read. */
  revision_of?: string | null;
  /** R-2740: the quote's value in ₹ incl. GST (the books' figure) and how it is shown to the customer. */
  amount?: number | null;
  currency?: string | null;
  exchange_rate?: number | null;
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
  /** R-2737: exclusive (the proforma prints period_end − 1). */
  period_end?: string | null;
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
  /* R-2737: what the /invoices status reads (overdue.ts, payment-state.ts). */
  due_date?: string | null;
  net_payable?: number | null;
  adjusted_advances?: unknown;
  written_off_at?: string | null;
  /** ₹ per unit of `currency` (the books stay in ₹, lib/currency.ts). */
  fx_rate?: number | null;
}

/** R-2737: a quote's lines + period context — read only for the quotes a row shows. */
export interface DocQuoteDetail {
  id: string;
  line_items: unknown;
  is_renewal: boolean | null;
  is_extension: boolean | null;
  is_add_seats: boolean | null;
  is_one_off: boolean | null;
  extension_months: number | null;
  renewal_term_date: string | null;
  created_date: string | null;
}

/** A billed part's stored period; endExclusive as subscription_billings keeps it. */
export interface DocPart { start: string | null; endExclusive: string | null }

export interface LastDocsInput {
  subs: ReadonlyArray<{
    id: string; quote_id: string | null; renewal_quote_id: string | null; start_date: string | null;
    /** R-2737: how a quote line is matched to this subscription (the sale files plan = line name, domain = line domain). */
    plan?: string | null; domain?: string | null;
  }>;
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
  /** R-2737: the billed part this quote (a part proforma) asks for; null = a whole quote. */
  part: DocPart | null;
  /** R-2737: the period it covers, in words (attachDocDetails); null = not known. */
  period: string | null;
}

export interface LastInvoice {
  id: string;
  date: string | null;
  status: string;
  /** Rupees incl. GST, as stored. */
  amount: number;
  paidAmount: number;
  currency: string | null;
  dueDate: string | null;
  netPayable: number | null;
  adjustedAdvances: unknown;
  writtenOffAt: string | null;
  fxRate: number | null;
  /** The quote it was raised from (invoices.quote_id, else the quote whose invoice_id is it). */
  sourceQuoteId: string | null;
  /** R-2748: that quote's state, when it was read (the row shows "from Q-… · Accepted"); null = not read. */
  sourceQuote?: SourceQuote | null;
  /** The billed part it is for; null = a whole-quote invoice. */
  part: DocPart | null;
  /** The period it covers, in words (attachDocDetails); null = not known. */
  period: string | null;
  /** Its credit / debit note totals; undefined = not read (never "credited"). */
  notes: NoteTotals | null | undefined;
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

/** R-2748: the quote an invoice came from — just what its state words need. */
export interface SourceQuote {
  id: string;
  status: string;
  payment_status: string | null;
  expires_date: string | null;
  invoice_id: string | null;
}

/** R-2740: any linked quote, for the drawer's full list. */
export interface DrawerQuote extends LastQuote {
  /** The newer revision that replaced it (quotes.superseded_by); null = current. */
  supersededBy: string | null;
  /** ₹ incl. GST as stored; null = not read. */
  amount: number | null;
  currency: string | null;
  fxRate: number | null;
}

export interface LastDocs {
  quote: LastQuote | null;
  invoice: LastInvoice | null;
  /** R-2748: up to two linked invoices, newest first (one of them is `invoice`); [] = none. */
  invoices: LastInvoice[];
  sent: SentRenewal | null;
  /** R-2747: the newest linked invoice with money still to collect (may be older than `invoice`); null = none. */
  owedInvoiceId?: string | null;
  /** R-2740 (`{ all: true }` only): every linked quote, newest first. */
  allQuotes?: DrawerQuote[];
  /** R-2740 (`{ all: true }` only): every issued linked invoice (void ones too), newest first. */
  allInvoices?: LastInvoice[];
}

/** Never sent to the customer, or taken back. */
const NOT_SENT = new Set(["draft", "cancelled", "void"]);
/** Never issued. A void / cancelled invoice still counts (R-2737: shown as "Cancelled"). */
const DRAFT_INVOICE = new Set(["draft"]);
const VOID_INVOICE = new Set(["void", "cancelled"]);
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

export function lastDocsBySubscription(input: LastDocsInput, opts: { all?: boolean } = {}): Map<string, LastDocs> {
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
  /* R-2740 (`all`): a revised-away quote lost its subscription link to its revision (R-2368), and an
     unsent revision draft has none yet — each belongs to the subscriptions of the quote it is a
     revision of / was replaced by, down the chain. */
  if (opts.all) {
    for (let changed = true, guard = 0; changed && guard < input.quotes.length + 1; guard++) {
      changed = false;
      for (const q of input.quotes) {
        for (const other of [q.superseded_by, q.revision_of]) {
          for (const sid of (other ? quoteSubs.get(other) : undefined) ?? []) {
            if (!quoteSubs.get(q.id)?.has(sid)) { add(quoteSubs, q.id, sid); changed = true; }
          }
        }
        /* and the quote it revises belongs to this one's subscriptions */
        if (q.revision_of) for (const sid of quoteSubs.get(q.id) ?? []) {
          if (!quoteSubs.get(q.revision_of)?.has(sid)) { add(quoteSubs, q.revision_of, sid); changed = true; }
        }
      }
    }
  }
  /* invoice id → subscriptions: raised from a linked quote (either side of the link) or for a billed part */
  const invoiceSubs = new Map<string, Set<string>>();
  const quoteById = new Map(input.quotes.map((q) => [q.id, q]));
  for (const q of input.quotes) if (q.invoice_id) for (const sid of quoteSubs.get(q.id) ?? []) add(invoiceSubs, q.invoice_id, sid);
  for (const i of input.invoices) if (i.quote_id) for (const sid of quoteSubs.get(i.quote_id) ?? []) add(invoiceSubs, i.id, sid);
  for (const b of input.billings) if (b.invoice_id && subIds.has(b.subscription_id)) add(invoiceSubs, b.invoice_id, b.subscription_id);

  const out = new Map<string, LastDocs>();
  for (const s of input.subs) out.set(s.id, { quote: null, invoice: null, invoices: [], sent: null });

  const bestQuote = new Map<string, DocQuote>();
  for (const q of quoteById.values()) {
    if (!isSent(q)) continue;
    for (const sid of quoteSubs.get(q.id) ?? []) {
      const cur = bestQuote.get(sid);
      if (!cur || newer({ at: q.created_at, id: q.id }, { at: cur.created_at, id: cur.id })) bestQuote.set(sid, q);
    }
  }
  const partOf = (billingId: string | null | undefined): DocPart | null => {
    const b = billingId ? billingById.get(billingId) : undefined;
    return b ? { start: b.period_start ?? null, endExclusive: b.period_end ?? null } : null;
  };
  for (const [sid, q] of bestQuote) {
    out.get(sid)!.quote = {
      id: q.id, date: (q.created_date ?? q.created_at).slice(0, 10), status: q.status,
      payment_status: q.payment_status, expires_date: q.expires_date, invoice_id: q.invoice_id,
      part: partOf(q.subscription_billing_id), period: null,
    };
  }

  /* The newest invoice — a void one too (R-2737: "Cancelled") — but never one that hides money
     still owed: a newer void never wins over an older live invoice with something left to collect. */
  const bestInvoice = new Map<string, DocInvoice>();
  const bestOwed = new Map<string, DocInvoice>();
  const seenInv = new Set<string>();
  const allOfSub = new Map<string, DocInvoice[]>();   // R-2748: every issued linked invoice, per subscription
  const atOf = (i: DocInvoice) => ({ at: `${i.invoice_date ?? ""}|${i.created_at ?? ""}`, id: i.id });
  for (const i of input.invoices) {
    if (seenInv.has(i.id) || DRAFT_INVOICE.has(i.status)) continue;
    seenInv.add(i.id);
    const owed = !VOID_INVOICE.has(i.status) && invoiceAmountDue({
      status: i.status, amount: Number(i.amount) || 0, net_payable: i.net_payable, paid_amount: Number(i.paid_amount) || 0,
      written_off_at: i.written_off_at,
    }) > 0;
    for (const sid of invoiceSubs.get(i.id) ?? []) {
      const list = allOfSub.get(sid);
      if (list) list.push(i); else allOfSub.set(sid, [i]);
      const cur = bestInvoice.get(sid);
      if (!cur || newer(atOf(i), atOf(cur))) bestInvoice.set(sid, i);
      const curOwed = bestOwed.get(sid);
      if (owed && (!curOwed || newer(atOf(i), atOf(curOwed)))) bestOwed.set(sid, i);
    }
  }
  for (const [sid, i] of bestInvoice) {
    const owed = bestOwed.get(sid);
    if (VOID_INVOICE.has(i.status) && owed) bestInvoice.set(sid, owed);
  }
  for (const [sid, i] of bestOwed) out.get(sid)!.owedInvoiceId = i.id;
  /* invoice → the quotes raised it, per subscription (a combined invoice can carry several subscriptions' quotes) */
  const quotesOfInvoice = new Map<string, string[]>();
  for (const qq of input.quotes) if (qq.invoice_id) quotesOfInvoice.set(qq.invoice_id, [...(quotesOfInvoice.get(qq.invoice_id) ?? []), qq.id]);
  const sourceQuoteFor = (invoiceId: string, sid: string) =>
    (quotesOfInvoice.get(invoiceId) ?? []).find((qid) => quoteSubs.get(qid)?.has(sid)) ?? null;
  /* invoice|subscription → THIS subscription's billed parts on that invoice (one invoice can bill
     parts of several subscriptions, or several parts of one — then the range they cover). */
  const partsOfInvoice = new Map<string, DocBilling[]>();
  for (const b of input.billings) {
    if (!b.invoice_id) continue;
    const k = `${b.invoice_id}|${b.subscription_id}`;
    partsOfInvoice.set(k, [...(partsOfInvoice.get(k) ?? []), b]);
  }
  const invoicePart = (invoiceId: string, sid: string): DocPart | null => {
    const bs = partsOfInvoice.get(`${invoiceId}|${sid}`);
    if (!bs?.length) return null;
    const starts = bs.map((b) => b.period_start ?? null);
    const ends = bs.map((b) => b.period_end ?? null);
    if (starts.some((x) => !x) || ends.some((x) => !x)) return { start: null, endExclusive: null };
    return { start: (starts as string[]).sort()[0], endExclusive: (ends as string[]).sort().at(-1)! };
  };
  const toLast = (i: DocInvoice, sid: string): LastInvoice => {
    const sourceQuoteId = i.quote_id ?? sourceQuoteFor(i.id, sid);
    const src = sourceQuoteId ? quoteById.get(sourceQuoteId) : undefined;
    const part = invoicePart(i.id, sid) ?? partOf(src?.subscription_billing_id);
    const fx = Number(i.fx_rate);
    return {
      id: i.id, date: i.invoice_date, status: i.status, amount: Number(i.amount) || 0,
      paidAmount: Number(i.paid_amount) || 0, currency: i.currency,
      dueDate: i.due_date ?? null,
      netPayable: i.net_payable == null ? null : Number(i.net_payable),
      adjustedAdvances: i.adjusted_advances ?? null,
      writtenOffAt: i.written_off_at ?? null,
      fxRate: Number.isFinite(fx) && fx > 0 ? fx : null,
      sourceQuoteId,
      sourceQuote: src ? { id: src.id, status: src.status, payment_status: src.payment_status, expires_date: src.expires_date, invoice_id: src.invoice_id } : null,
      part, period: null, notes: undefined,
    };
  };
  for (const [sid, i] of bestInvoice) {
    /* R-2748: the R-2737 pick + one more, shown newest first: the newest invoice still owed when it
       is not already the pick (money owed is never pushed off the row), else the newest other one */
    const owed = bestOwed.get(sid);
    let other: DocInvoice | undefined = owed && owed.id !== i.id ? owed : undefined;
    if (!other) for (const x of allOfSub.get(sid) ?? []) if (x.id !== i.id && (!other || newer(atOf(x), atOf(other)))) other = x;
    const two = other ? (newer(atOf(other), atOf(i)) ? [other, i] : [i, other]) : [i];
    const d = out.get(sid)!;
    d.invoices = two.map((x) => toLast(x, sid));
    d.invoice = d.invoices.find((x) => x.id === i.id)!;
  }

  /* R-2740: the drawer's full lists — the same links as above, nothing left out (a draft, a revised-away
     or a cancelled quote is listed with its own status, so the history has no gaps). */
  if (opts.all) {
    const byAt = (a: { at: string; id: string }, b: { at: string; id: string }) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0);
    const quotesOfSub = new Map<string, DocQuote[]>();
    for (const q of quoteById.values()) for (const sid of quoteSubs.get(q.id) ?? []) {
      const list = quotesOfSub.get(sid);
      if (list) list.push(q); else quotesOfSub.set(sid, [q]);
    }
    for (const s of input.subs) {
      const d = out.get(s.id)!;
      d.allQuotes = (quotesOfSub.get(s.id) ?? [])
        .sort((a, b) => byAt({ at: a.created_at, id: a.id }, { at: b.created_at, id: b.id }))
        .map((q): DrawerQuote => {
          const fx = Number(q.exchange_rate);
          return {
            id: q.id, date: (q.created_date ?? q.created_at).slice(0, 10), status: q.status,
            payment_status: q.payment_status, expires_date: q.expires_date, invoice_id: q.invoice_id,
            part: partOf(q.subscription_billing_id), period: null,
            supersededBy: q.superseded_by ?? null,
            amount: q.amount == null ? null : Number(q.amount),
            currency: q.currency ?? null,
            fxRate: Number.isFinite(fx) && fx > 0 ? fx : null,
          };
        });
      d.allInvoices = [...(allOfSub.get(s.id) ?? [])].sort((a, b) => byAt(atOf(a), atOf(b))).map((x) => toLast(x, s.id));
    }
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

/**
 * R-2767 (R-2742, audit P10): on the ROW a quote's validity shows only when it matters — 3 days or less
 * left, or expired. No expiry (a part proforma never expires) or more days left → null (the drawer has it).
 */
export const EXPIRY_ROW_DAYS = 3;
export function quoteExpiryNote(expiresDate: string | null | undefined, todayIst: string): string | null {
  const left = validityDaysLeft(expiresDate, todayIst);
  if (left == null || left - 1 > EXPIRY_ROW_DAYS) return null;
  return quoteExpiryText(expiresDate, todayIst);
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

export type DocTone = "ok" | "warn" | "danger" | "muted";

/** ₹ as the books hold it; a foreign-currency document in its own currency (₹ ÷ fx_rate, lib/currency.ts). */
export function docMoney(i: { currency: string | null; fxRate: number | null }, inr: number): string {
  const cur = (i.currency ?? "INR").trim().toUpperCase();
  if (!isForeignCurrency(cur)) return rupee(Math.round(inr));
  if (!i.fxRate) return `${rupee(Math.round(inr))} (${cur})`;
  const v = Math.round(foreignEquivalent(inr, i.fxRate) * 100) / 100;
  return formatForeign(v, cur, Number.isInteger(v) ? 0 : 2);
}

/** R-2748: the invoice's whole value (incl. GST) in its own currency — "₹40,000" / "$1,200". */
export function invoiceTotalWords(i: LastInvoice): string {
  return docMoney(i, i.amount);
}

/**
 * R-2748: the state of the quote an invoice came from — its own status ("Accepted" / "Sent").
 * Never a payment word: the invoice line beside it already says Paid / Overdue, from the invoice
 * (a quote's payment_status can say "received" while its invoice is still overdue — two answers).
 */
export function sourceQuoteState(q: Pick<SourceQuote, "status">): string {
  return q.status.charAt(0).toUpperCase() + q.status.slice(1);
}

/**
 * R-2737 — the last invoice's state, by the /invoices rules (overdue.ts + payment-state.ts):
 * "Paid" · "Part paid · ₹x due" · "Unpaid · ₹x" · "Overdue Nd · ₹x" (past its due date, IST; no due
 * date = never overdue) · "Cancelled" (void) · "Cancelled · credit note" (notes for the whole value)
 * · "Credited" · "Written off". ₹x = what is still due (net_payable − money in, as the dunning
 * engine reads it — lib/payments/amount-due.ts).
 */
export function invoiceStatusWords(i: LastInvoice, todayIst: string): { text: string; tone: DocTone } {
  if (VOID_INVOICE.has(i.status)) return { text: "Cancelled", tone: "muted" };
  const facts = {
    status: i.status, amount: i.amount, net_payable: i.netPayable, paid_amount: i.paidAmount,
    adjusted_advances: i.adjustedAdvances, written_off_at: i.writtenOffAt,
    credit_noted: i.notes === undefined ? undefined : i.notes?.credit ?? 0,
    debit_noted: i.notes?.debit ?? 0,
  };
  if (i.notes && fullyCredited(facts)) return { text: "Cancelled · credit note", tone: "muted" };
  const state = invoicePaymentState(facts);
  if (state === "paid") return { text: "Paid", tone: "ok" };
  if (state === "credited") return { text: "Credited", tone: "muted" };
  if (state === "written-off") return { text: "Written off", tone: "muted" };
  if (state === "draft") return { text: "Draft", tone: "muted" };
  const row = {
    status: i.status, due_date: i.dueDate, amount: i.amount, net_payable: i.netPayable,
    paid_amount: i.paidAmount, written_off_at: i.writtenOffAt, adjusted_advances: i.adjustedAdvances,
  };
  const due = invoiceAmountDue(row);
  /* nothing left to collect but not marked paid: advances adjusted at issue covered it (/invoices: "Partial") */
  if (due <= 0) return state === "partial" ? { text: "Covered by advance", tone: "ok" } : { text: `Unpaid · ${docMoney(i, 0)}`, tone: "warn" };
  const money = docMoney(i, due);
  if (invoiceIsOverdue(row, todayIst)) {
    const d = invoiceOverdueDays(row, todayIst);
    return { text: `Overdue${d > 0 ? ` ${d}d` : ""} · ${money}${state === "partial" ? " due" : ""}`, tone: "danger" };
  }
  if (state === "partial") return { text: `Part paid · ${money} due`, tone: "warn" };
  return { text: `Unpaid · ${money}`, tone: "warn" };
}

/**
 * R-2747 — a row says "Previous term ₹x still unpaid" (prior-due.ts) but shows no unpaid invoice:
 * say plainly why, never invent one. null = nothing owed, or the shown invoice already says it.
 * Only invoices LINKED to the subscription (its quotes / billed parts) are known here, so the words
 * say "linked" — an invoice raised by hand for the customer, or imported, may still exist.
 * (Seen on SCN Kochi Hosting / SCN Delhi Traders: the balance is only on
 * subscriptions.outstanding_amount — no quote, no invoice linked to the subscription.)
 */
export function priorDueInvoiceGap(docs: LastDocs | undefined, priorDue: number, todayIst: string): string | null {
  if (!(priorDue > 0)) return null;
  const invoice = docs?.invoice ?? null;
  const shown = docs?.invoices ?? [];
  if (invoice) {
    const { tone } = invoiceStatusWords(invoice, todayIst);
    if (tone === "warn" || tone === "danger") return null;
  }
  /* an older linked invoice still has money due: on screen (R-2748) its own line says so; else name it */
  const owed = docs?.owedInvoiceId ?? null;
  if (owed && shown.some((i) => i.id === owed)) return null;
  if (owed) return `Older invoice ${owed} still has money due`;
  /* R-2752: the balance is subscriptions.outstanding_amount and no unpaid invoice LINKED to the
     subscription carries it (a hand-raised / imported invoice for the customer may) — true whether the
     row shows a Paid / Cancelled invoice or none */
  return "Balance on the subscription — no unpaid invoice linked to it";
}

/**
 * R-2752 — the newest shown invoice that is settled ("Paid" / "Covered by advance" — tone ok, the
 * same words as its own line), for the Last paid line when no receipt is linked: an invoice the row
 * shows as settled is never next to "never paid".
 */
export function paidInvoiceOf(docs: LastDocs | undefined, todayIst: string): { id: string; words: string } | null {
  for (const i of docs?.invoices ?? []) {
    const s = invoiceStatusWords(i, todayIst);
    if (s.tone === "ok") return { id: i.id, words: s.text };
  }
  return null;
}

/* "Nov 2026" = periodDate("2026-11-01") without its day — the paper's own formatter (service-period.ts). */
const monYear = (iso: string) => periodDate(`${iso.slice(0, 7)}-01`).replace(/^1 /, "");
const dayMonYear = (iso: string) => periodDate(iso.slice(0, 10));
const isMonthEnd = (iso: string) => addDaysIso(iso, 1).slice(8, 10) === "01";
const ISO_START = /^\d{4}-\d{2}-\d{2}/;
const isoOrNull = (v: string | null | undefined) => (v && ISO_START.test(v) ? v.slice(0, 10) : null);

/**
 * R-2737 — a period in words, both ends inclusive (YYYY-MM-DD): whole calendar months under a
 * year → "Nov 2026" / "Nov 2026 – Jan 2027"; otherwise "1 Nov 2026 – 31 Oct 2027"; whole years
 * from 2 up add "(N yr)" (multi-year domains, R-2710).
 */
export function periodWords(from: string, toInclusive: string, months?: number | null): string {
  const span = (Number(toInclusive.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(toInclusive.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  if (from.slice(8, 10) === "01" && isMonthEnd(toInclusive) && span >= 1 && span < 12) {
    const a = monYear(from);
    const b = monYear(toInclusive);
    return a === b ? a : `${a} – ${b}`;
  }
  const yr = months && months >= 24 && months % 12 === 0 ? ` (${months / 12} yr)` : "";
  return `${dayMonYear(from)} – ${dayMonYear(toInclusive)}${yr}`;
}

/** A billed part's stored period (subscription_billings, period_end exclusive) in words. */
export function partPeriodWords(start: string | null | undefined, endExclusive: string | null | undefined): string | null {
  const a = isoOrNull(start);
  const b = isoOrNull(endExclusive);
  if (!a || !b || b <= a) return null;
  return periodWords(a, addDaysIso(b, -1));
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

type MatchLine = LinePeriodLine & { plan_change?: { subscription_id?: string } | null };
type SubMatch = { id: string; plan?: string | null; domain?: string | null };

/**
 * Which of a quote's lines belong to THIS subscription (Pardeep, 13 Nov: one invoice can carry
 * lines with different periods — the row shows its own). How the sale filed it (record_payment):
 * one subscription per subscription line, plan = the line's name, domain = the line's own domain
 * (a bulk line: one subscription per listed domain). So, most certain first:
 *   1. a line naming the subscription (plan_change.subscription_id);
 *   2. name = plan AND (line domain = subscription domain, or a bulk line listing it);
 *   3. name = plan (one plan on the quote, or the domain came from the quote / customer);
 *   4. line domain = subscription domain (the plan was renamed / changed since);
 *   5. the quote has ONE line with a period — it is that one.
 * Nothing matched → [] (no period shown; never another line's dates).
 */
export function linesForSubscription<L extends MatchLine>(lines: readonly L[], sub: SubMatch | null | undefined): L[] {
  if (lines.length <= 1 || !sub) return lines.length === 1 ? [...lines] : [];
  const plan = norm(sub.plan);
  const dom = norm(sub.domain);
  const domOf = (l: L) => {
    const own = norm(l.domain);
    if (own) return own === dom;
    return Array.isArray(l.domains) && l.domains.some((d) => norm(d?.domain) === dom);
  };
  const tries: Array<(l: L) => boolean> = [
    (l) => l.plan_change?.subscription_id === sub.id,
    (l) => !!plan && !!dom && norm(l.name) === plan && domOf(l),
    (l) => !!plan && norm(l.name) === plan,
    (l) => !!dom && domOf(l),
  ];
  for (const t of tries) {
    const hit = lines.filter(t);
    if (!hit.length) continue;
    /* same name on lines for DIFFERENT domains, and this subscription's domain picks none of them:
       which one is it? Not known → no period (never a range made of other subscriptions' lines) */
    const ownDomains = new Set(hit.map((l) => norm(l.domain)).filter(Boolean));
    if (t === tries[2] && ownDomains.size > 1) return [];
    return hit;
  }
  return [];
}

/**
 * The period a whole quote's lines cover — the invoice / quote paper's "Subscription period"
 * (lineServicePeriod, R-1764) of the line(s) that belong to `sub` (linesForSubscription); several
 * of them → the range they cover. Null when the paper prints none for those lines (one-off, a
 * renewal quote with no renewal_term_date, …) or no line matches — never a guess.
 */
export function quoteLinesPeriod(q: DocQuoteDetail, sub?: SubMatch | null): string | null {
  const ctx = quoteLinePeriodContext(q);
  const all = (Array.isArray(q.line_items) ? (q.line_items as MatchLine[]) : []).filter((l) => !!l && typeof l === "object");
  const withP = all.map((line) => ({ line, p: lineServicePeriod(line, ctx) }));
  /* lines that can be a subscription: a certain period, or a renewing commitment (a one-off fee is never one) */
  const candidates = withP.filter(({ line, p }) => !!p || (line.one_time !== true && !!norm(line.commitment) && norm(line.commitment) !== "one_time"));
  /* a renewal / extension / add-seats quote is for ONE subscription — all its lines are that one's */
  const mine = q.is_renewal || q.is_extension || q.is_add_seats
    ? new Set(candidates.map((c) => c.line))
    : new Set(linesForSubscription(candidates.map((c) => c.line), sub));
  const own = candidates
    .filter((c) => mine.has(c.line))
    .filter((c): c is { line: MatchLine; p: NonNullable<ReturnType<typeof lineServicePeriod>> } => !!c.p);
  if (!own.length) return null;
  const from = own.map((d) => d.p.from).sort()[0];
  const to = own.map((d) => d.p.to).sort().at(-1)!;
  const months = own.every((d) => d.p.months === own[0].p.months) ? own[0].p.months : null;
  return periodWords(from, to, months);
}

/**
 * R-2737 — fills each shown document's period and the invoice's note totals from the second read
 * (last-docs-data.ts). `details` null = that read failed: no period, notes "not read".
 */
export function attachDocDetails(
  docs: Map<string, LastDocs>,
  details: { quotes: readonly DocQuoteDetail[]; notes: ReadonlyMap<string, NoteTotals> } | null,
  subs: readonly SubMatch[] = [],
): Map<string, LastDocs> {
  const byId = new Map((details?.quotes ?? []).map((q) => [q.id, q]));
  const subById = new Map(subs.map((s) => [s.id, s]));
  const periodOf = (part: DocPart | null, quoteId: string | null, sid: string): string | null => {
    if (part) return partPeriodWords(part.start, part.endExclusive);
    const q = quoteId ? byId.get(quoteId) : undefined;
    return q ? quoteLinesPeriod(q, subById.get(sid) ?? { id: sid }) : null;
  };
  const withDetails = (i: LastInvoice, sid: string): LastInvoice => ({
    ...i,
    period: periodOf(i.part, i.sourceQuoteId, sid),
    notes: details ? details.notes.get(i.id) ?? { credit: 0, debit: 0 } : undefined,
  });
  /* `invoice` stays the SAME object as its entry in `invoices` (one copy of each fact) */
  const oneCopy = (invoices: LastInvoice[], pick: LastInvoice | null) => ({ invoices, invoice: pick ? invoices.find((x) => x.id === pick.id) ?? null : null });
  const out = new Map<string, LastDocs>();
  for (const [sid, d] of docs) {
    out.set(sid, {
      ...d,
      quote: d.quote ? { ...d.quote, period: periodOf(d.quote.part, d.quote.id, sid) } : null,
      ...oneCopy((d.invoices ?? []).map((i) => withDetails(i, sid)), d.invoice),
      ...(d.allQuotes ? { allQuotes: d.allQuotes.map((q) => ({ ...q, period: periodOf(q.part, q.id, sid) })) } : {}),
      ...(d.allInvoices ? { allInvoices: d.allInvoices.map((i) => withDetails(i, sid)) } : {}),
    });
  }
  return out;
}

/** R-2737: the quotes whose lines a row's period needs (whole quotes only — a part has its own). */
export function detailQuoteIds(docs: Map<string, LastDocs>): string[] {
  const ids = new Set<string>();
  for (const d of docs.values()) {
    if (d.quote && !d.quote.part) ids.add(d.quote.id);
    for (const i of [...(d.invoices ?? []), ...(d.allInvoices ?? [])]) if (!i.part && i.sourceQuoteId) ids.add(i.sourceQuoteId);
    for (const q of d.allQuotes ?? []) if (!q.part) ids.add(q.id);   // R-2740
  }
  return [...ids].sort();
}

/** R-2737: the invoices whose credit / debit notes the status needs. */
export function shownInvoiceIds(docs: Map<string, LastDocs>): string[] {
  return [...new Set([...docs.values()].flatMap((d) => [...(d.invoices ?? []), ...(d.allInvoices ?? [])].map((i) => i.id)).filter((x): x is string => !!x))].sort();
}
