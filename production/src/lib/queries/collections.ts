/**
 * R-1516 — /collections ("Payment Follow-up"): who owes money, and whom to chase first.
 *
 * WHERE "OWED" COMES FROM — nothing new is invented here:
 *   • Invoices in `pending` / `overdue` with a balance — `invoiceAmountDue`
 *     (lib/payments/amount-due): net_payable (after advances / credit notes at issue) minus
 *     receipts since. The same set and the same sum as Customer Aging, the Accounting
 *     "Owed to you" folder and the dunning cron.
 *   • Subscriptions with `outstanding_amount > 0` that are not written off — the
 *     "Outstanding Receivables" card on /payments (useOutstandingReceivables). Counted ONLY
 *     when no invoice exists for that subscription's quote: once the quote is invoiced, the
 *     invoice is the claim, and adding the subscription balance too would ask for the same
 *     money twice (amount-due.ts: when in doubt, ask for LESS).
 *   • Accepted-but-unpaid quotes are NOT a separate line: no receivables screen in the app
 *     counts them (aging, dunning, /payments), and a quote that went live already shows
 *     through its subscription or invoice. Each line links its quote when it has one.
 *
 * FOLLOW-UPS (R-1515, table payment_followups): per customer, the newest row gives the
 * next follow-up date and last note; the newest row that carries a promise date gives the
 * promise. Its status (kept / broken / due / open) is followup-rules.ts promiseStatus — R-1540:
 * the same rule as the weekly report and the history; BROKEN = the date has passed and the
 * promised cash did not come in between logging and that date (and the customer still owes).
 * The owner is customers.account_manager_id (R-1514 decision), the newest follow-up's
 * `assigned_to` may hand it to someone else — "Mere" matches either.
 *
 * NO READ STOPS AT 1000 ROWS: every select pages through fetchAllRows / fetchAllRowsIn
 * with a total order ending on `id` (R-1509 / R-1519 lesson).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { matchTdsShortfall, type TdsShortfallMatch } from "@/lib/accounting/tds-match";
import { istDayStartUtc, istToday, toIstDate } from "@/lib/dates/ist";
import {
  promiseLoggedOn, promiseReceipts, promiseStatus, type PromisePayment, type PromiseStatus,
} from "@/lib/collections/followup-rules";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { subscriptionHref } from "@/app/(app)/subscriptions/palette-links";

// ─── Row shapes (only the columns this page reads) ───────────────────────────

export interface CollectionInvoice {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  amount: number | null;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  quote_id: string | null;
  taxable_value: number | null;
  tax_amount: number | null;
  tax_rate: number | null;
}

export interface CollectionSubscription {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  plan: string | null;
  domain: string | null;
  quote_id: string | null;
  outstanding_amount: number | null;
  payment_due_date: string | null;
  created_at: string | null;
}

export interface CollectionCustomer {
  id: string;
  name: string;
  display_name: string | null;
  account_manager_id: string | null;
}

export interface CollectionFollowup {
  id: string;
  customer_id: string;
  kind: string;
  note: string | null;
  promised_amount: number | null;
  promised_on: string | null;
  next_follow_up_on: string | null;
  assigned_to: string | null;
  created_at: string;
}

export interface CollectionsInput {
  invoices: readonly CollectionInvoice[];
  /** Subscriptions with a balance (outstanding_amount > 0, not written off). */
  subscriptions: readonly CollectionSubscription[];
  /** Subscriptions of the invoices' quotes — only to link them from an invoice line. */
  quoteSubscriptions: readonly CollectionSubscription[];
  /** Quote ids that already have an invoice (any status) — their subscription balance is the invoice's. */
  invoicedQuoteIds: ReadonlySet<string>;
  customers: readonly CollectionCustomer[];
  followups: readonly CollectionFollowup[];
  /**
   * R-1540: received payments of these customers since their oldest promise was logged — what
   * keeps a promise (promiseStatus). Absent → only "owes nothing" keeps one.
   */
  payments?: readonly PromisePayment[];
}

// ─── What the page shows ─────────────────────────────────────────────────────

export interface OwedItem {
  kind: "invoice" | "subscription";
  id: string;
  /** Invoice number, or the subscription's plan / domain. */
  label: string;
  href: string;
  quoteId: string | null;
  quoteHref: string | null;
  subscriptionHref: string | null;
  amountDue: number;
  daysOverdue: number;
  /** "Shayad TDS hai" — the balance equals a common TDS of the invoice's pre-GST value (R-1520 helper). */
  tdsHint: TdsShortfallMatch | null;
}

export interface CollectionRow {
  key: string;
  customerId: string | null;
  customerName: string;
  customerHref: string | null;
  /** customers.account_manager_id. */
  ownerId: string | null;
  /** The newest follow-up's assigned_to, when set. */
  assignedTo: string | null;
  items: OwedItem[];
  amountDue: number;
  /** Of the oldest line. 0 or less = not yet due. */
  daysOverdue: number;
  promisedOn: string | null;
  promisedAmount: number | null;
  /** R-1540: promiseStatus of the newest promise — the same answer as the weekly report. */
  promiseStatus: PromiseStatus | null;
  /** promiseStatus === "broken". */
  promiseBroken: boolean;
  /** This customer's payments (input.payments) — the follow-up history needs them for the same rule. */
  payments: PromisePayment[];
  nextFollowUpOn: string | null;
  /** Next follow-up is today or already past. */
  followUpDue: boolean;
  lastNote: string | null;
  lastNoteOn: string | null;
}

export const COLLECTION_VIEWS = ["mine", "all", "broken"] as const;
export type CollectionView = (typeof COLLECTION_VIEWS)[number];

// ─── Pure rules ──────────────────────────────────────────────────────────────

/**
 * The invoice's GST rate for the TDS base: its own tax_rate, else tax_amount ÷ pre-GST value
 * (taxable_value, or amount − tax_amount). null → matchTdsShortfall / tdsBase assume 18%.
 */
export function invoiceGstRatePct(inv: Pick<CollectionInvoice, "amount" | "taxable_value" | "tax_amount" | "tax_rate">): number | null {
  if (typeof inv.tax_rate === "number" && Number.isFinite(inv.tax_rate) && inv.tax_rate >= 0) return inv.tax_rate;
  if (typeof inv.tax_amount !== "number") return null;
  const base = typeof inv.taxable_value === "number" && inv.taxable_value > 0
    ? inv.taxable_value
    : typeof inv.amount === "number" ? inv.amount - inv.tax_amount : 0;
  return base > 0 ? Math.round((inv.tax_amount / base) * 10_000) / 100 : null;
}

/**
 * "Shayad TDS hai" — the balance equals a common TDS of the invoice's pre-GST value (±₹1),
 * i.e. TDS the customer deducted and paid to the government, not money still to chase.
 * R-1520's shared matchTdsShortfall (lib/accounting/tds-match) — the same rule as the Record
 * payment sheet and the invoice page. total = the invoice amount incl. GST; received = total
 * minus what is still due (invoiceAmountDue), so advances / credit notes count as settled.
 * INV-A378 (Pardeep, 17 Oct): ₹25,500 left = 10% (194J) of ₹2,55,000.
 */
export function tdsHint(inv: CollectionInvoice): TdsShortfallMatch | null {
  const due = invoiceAmountDue(inv);
  if (due <= 0) return null;
  const total = Math.round(inv.amount ?? inv.net_payable ?? 0);
  return matchTdsShortfall({ totalInclGst: total, received: total - due, gstRatePct: invoiceGstRatePct(inv) });
}

/** Whole days from `date` (YYYY-MM-DD…) to `today` (YYYY-MM-DD), IST calendar days. */
export function daysSince(date: string | null | undefined, today: string): number {
  if (!date) return 0;
  const a = Date.parse(`${date.slice(0, 10)}T00:00:00+05:30`);
  const b = Date.parse(`${today}T00:00:00+05:30`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export const customerHref = (id: string) => `/customers/${encodeURIComponent(id)}`;
export const quoteHref = (id: string) => `/quotes/${encodeURIComponent(id)}`;

/** Newest first, ties by id — the "latest" follow-up must not depend on row order. */
function newestFirst(a: CollectionFollowup, b: CollectionFollowup): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Today's work first: a follow-up due today/earlier or a broken promise. */
export function needsActionToday(r: Pick<CollectionRow, "followUpDue" | "promiseBroken">): boolean {
  return r.followUpDue || r.promiseBroken;
}

/**
 * Order: (1) follow-up due today or earlier, or promise broken; (2) the rest. Inside each,
 * the most overdue first, then the biggest amount, then name (stable for equal rows).
 */
export function compareCollectionRows(a: CollectionRow, b: CollectionRow): number {
  const ta = needsActionToday(a) ? 0 : 1;
  const tb = needsActionToday(b) ? 0 : 1;
  if (ta !== tb) return ta - tb;
  if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
  if (a.amountDue !== b.amountDue) return b.amountDue - a.amountDue;
  return a.customerName.localeCompare(b.customerName);
}

/** One row per customer with everything they still owe, sorted for the follow-up person. */
export function buildCollectionRows(input: CollectionsInput, today: string): CollectionRow[] {
  const customers = new Map(input.customers.map((c) => [c.id, c]));
  const subByQuote = new Map<string, CollectionSubscription>();
  for (const s of [...input.quoteSubscriptions, ...input.subscriptions]) {
    if (s.quote_id && !subByQuote.has(s.quote_id)) subByQuote.set(s.quote_id, s);
  }

  const rows = new Map<string, CollectionRow>();
  const rowFor = (customerId: string | null, fallbackName: string | null): CollectionRow => {
    const key = customerId ?? `name:${(fallbackName ?? "").trim().toLowerCase() || "unknown"}`;
    let row = rows.get(key);
    if (!row) {
      const c = customerId ? customers.get(customerId) : undefined;
      row = {
        key,
        customerId,
        customerName: c?.display_name?.trim() || c?.name?.trim() || fallbackName?.trim() || "—",
        customerHref: customerId ? customerHref(customerId) : null,
        ownerId: c?.account_manager_id ?? null,
        assignedTo: null,
        items: [],
        amountDue: 0,
        daysOverdue: 0,
        promisedOn: null,
        promisedAmount: null,
        promiseStatus: null,
        promiseBroken: false,
        payments: [],
        nextFollowUpOn: null,
        followUpDue: false,
        lastNote: null,
        lastNoteOn: null,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const inv of input.invoices) {
    if (inv.status !== "pending" && inv.status !== "overdue") continue;
    const due = invoiceAmountDue(inv);
    if (due <= 0) continue;
    const sub = inv.quote_id ? subByQuote.get(inv.quote_id) : undefined;
    rowFor(inv.customer_id, inv.customer_name).items.push({
      kind: "invoice",
      id: inv.id,
      label: inv.id,
      href: invoiceHref(inv.id),
      quoteId: inv.quote_id,
      quoteHref: inv.quote_id ? quoteHref(inv.quote_id) : null,
      subscriptionHref: sub ? subscriptionHref(sub) : null,
      amountDue: due,
      daysOverdue: daysSince(inv.due_date ?? inv.invoice_date, today),
      tdsHint: tdsHint(inv),
    });
  }

  for (const s of input.subscriptions) {
    const due = Math.max(0, Math.round(s.outstanding_amount ?? 0));
    if (due <= 0) continue;
    if (s.quote_id && input.invoicedQuoteIds.has(s.quote_id)) continue;   // the invoice is the claim
    const href = subscriptionHref(s);
    rowFor(s.customer_id, s.customer_name).items.push({
      kind: "subscription",
      id: s.id,
      label: [s.plan, s.domain].filter((x) => x && x.trim()).join(" · ") || "Subscription",
      href,
      quoteId: s.quote_id,
      quoteHref: s.quote_id ? quoteHref(s.quote_id) : null,
      subscriptionHref: href,
      amountDue: due,
      daysOverdue: daysSince(s.payment_due_date ?? s.created_at, today),
      tdsHint: null,
    });
  }

  const followupsByCustomer = new Map<string, CollectionFollowup[]>();
  for (const f of input.followups) {
    const list = followupsByCustomer.get(f.customer_id);
    if (list) list.push(f);
    else followupsByCustomer.set(f.customer_id, [f]);
  }

  const paymentsByCustomer = new Map<string, PromisePayment[]>();
  for (const p of input.payments ?? []) {
    if (!p.customer_id) continue;
    const list = paymentsByCustomer.get(p.customer_id);
    if (list) list.push(p);
    else paymentsByCustomer.set(p.customer_id, [p]);
  }

  for (const row of rows.values()) {
    row.items.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountDue - a.amountDue);
    row.amountDue = row.items.reduce((s, i) => s + i.amountDue, 0);
    row.daysOverdue = row.items.reduce((m, i) => Math.max(m, i.daysOverdue), Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(row.daysOverdue)) row.daysOverdue = 0;

    const fus = row.customerId ? [...(followupsByCustomer.get(row.customerId) ?? [])].sort(newestFirst) : [];
    const latest = fus[0];
    if (latest) {
      row.assignedTo = latest.assigned_to;
      row.nextFollowUpOn = latest.next_follow_up_on;
      row.followUpDue = !!latest.next_follow_up_on && latest.next_follow_up_on.slice(0, 10) <= today;
      row.lastNote = latest.note?.trim() || null;
      row.lastNoteOn = latest.created_at.slice(0, 10);
    }
    if (row.customerId) row.payments = paymentsByCustomer.get(row.customerId) ?? [];
    const promise = fus.find((f) => !!f.promised_on);
    if (promise?.promised_on) {
      const on = promise.promised_on.slice(0, 10);
      row.promisedOn = on;
      row.promisedAmount = promise.promised_amount;
      // R-1540: the one rule (followup-rules.ts promiseStatus) — the weekly report and the
      // history ask the same function, so "kept" there is never "broken" here.
      row.promiseStatus = promiseStatus({
        promisedOn: on,
        promisedAmount: promise.promised_amount,
        loggedOn: promiseLoggedOn(fus, on) ?? toIstDate(promise.created_at),
        today,
        receipts: promiseReceipts(row.payments),
        stillOwes: row.amountDue > 0,
      }).status;
      row.promiseBroken = row.promiseStatus === "broken";
    }
  }

  return [...rows.values()].filter((r) => r.amountDue > 0).sort(compareCollectionRows);
}

/** "Mere": the customer is mine (owner) or the latest follow-up was handed to me. */
export function isMine(r: Pick<CollectionRow, "ownerId" | "assignedTo">, meId: string | null | undefined): boolean {
  if (!meId) return false;
  return r.ownerId === meId || r.assignedTo === meId;
}

export function filterCollectionRows(rows: readonly CollectionRow[], view: CollectionView, meId: string | null | undefined): CollectionRow[] {
  if (view === "mine") return rows.filter((r) => isMine(r, meId));
  if (view === "broken") return rows.filter((r) => r.promiseBroken);
  return [...rows];
}

/** Sales people start on their own customers; everyone else on the whole list. */
export function defaultCollectionView(role: string | null | undefined): CollectionView {
  return role === "sales" || role === "sales_senior" ? "mine" : "all";
}

// ─── Reads ───────────────────────────────────────────────────────────────────

type Client = ReturnType<typeof createClient>;

const INVOICE_COLS =
  "id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date, quote_id, taxable_value, tax_amount, tax_rate";
const SUB_COLS = "id, customer_id, customer_name, plan, domain, quote_id, outstanding_amount, payment_due_date, created_at";

/**
 * Every row this page needs — each read paged past PostgREST's 1000-row cap. RLS scopes all of it.
 * R-1517: `customerId` narrows it to one customer (the customer page's follow-up card).
 */
export async function fetchCollectionsInput(supabase: Client, customerId?: string): Promise<CollectionsInput> {
  const [invoices, subscriptions] = await Promise.all([
    fetchAllRows<CollectionInvoice>((from, to) => {
      let q = supabase.from("invoices").select(INVOICE_COLS).in("status", ["pending", "overdue"]);
      if (customerId) q = q.eq("customer_id", customerId);
      return q.order("id", { ascending: true }).range(from, to);
    }),
    fetchAllRows<CollectionSubscription>((from, to) => {
      let q = supabase.from("subscriptions").select(SUB_COLS).gt("outstanding_amount", 0).is("written_off_at", null);
      if (customerId) q = q.eq("customer_id", customerId);
      return q.order("id", { ascending: true }).range(from, to);
    }),
  ]);

  const invoiceQuoteIds = invoices.map((i) => i.quote_id);
  const subQuoteIds = subscriptions.map((s) => s.quote_id);
  const customerIds = [...invoices.map((i) => i.customer_id), ...subscriptions.map((s) => s.customer_id)];

  const [quoteSubscriptions, invoicedQuotes, customers, followups] = await Promise.all([
    fetchAllRowsIn<CollectionSubscription, string>(invoiceQuoteIds, (ids, from, to) => supabase
      .from("subscriptions")
      .select(SUB_COLS)
      .in("quote_id", ids)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(subQuoteIds, (ids, from, to) => supabase
      .from("invoices")
      .select("id, quote_id")
      .in("quote_id", ids)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRowsIn<CollectionCustomer, string>(customerIds, (ids, from, to) => supabase
      .from("customers")
      .select("id, name, display_name, account_manager_id")
      .in("id", ids)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRowsIn<CollectionFollowup, string>(customerIds, (ids, from, to) => supabase
      .from("payment_followups")
      .select("id, customer_id, kind, note, promised_amount, promised_on, next_follow_up_on, assigned_to, created_at")
      .in("customer_id", ids)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)),
  ]);

  // R-1540: the cash that can keep a promise — received payments since the oldest promise was logged.
  let oldestPromise: string | null = null;
  for (const f of followups) {
    if (f.promised_on && (oldestPromise === null || f.created_at < oldestPromise)) oldestPromise = f.created_at;
  }
  const promiseCustomerIds = [...new Set(followups.filter((f) => !!f.promised_on).map((f) => f.customer_id))];
  const payments = oldestPromise === null ? [] : await fetchAllRowsIn<PromisePayment & { id: string }, string>(
    promiseCustomerIds,
    (ids, from, to) => supabase
      .from("payments")
      .select("id, customer_id, amount, credit_applied, received_at, status")
      .in("customer_id", ids)
      .eq("status", "received")
      .gte("received_at", istDayStartUtc(toIstDate(oldestPromise as string)).toISOString())
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  return {
    payments,
    invoices,
    subscriptions,
    quoteSubscriptions,
    invoicedQuoteIds: new Set(invoicedQuotes.map((i) => i.quote_id).filter((x): x is string => !!x)),
    customers,
    followups,
  };
}

export function useCollections() {
  return useQuery({
    queryKey: ["collections"],
    queryFn: async (): Promise<CollectionRow[]> =>
      buildCollectionRows(await fetchCollectionsInput(createClient()), istToday()),
    staleTime: 30_000,
  });
}

/**
 * R-1517: one customer's row (what they owe, promise, owner, latest assignee), or null when they
 * owe nothing. Keyed under ["collections"], so saving a follow-up refreshes it with the list.
 */
export function useCustomerCollection(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["collections", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<CollectionRow | null> =>
      buildCollectionRows(await fetchCollectionsInput(createClient(), customerId ?? undefined), istToday())
        .find((r) => r.customerId === customerId) ?? null,
    staleTime: 30_000,
  });
}
