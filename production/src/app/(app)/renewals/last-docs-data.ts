"use client";
/**
 * R-2728 — the batched read behind each Renewals row's last quote sent / last invoice and its
 * "Renewal quote sent" state (rules: ./last-docs.ts).
 *
 * ONE query set for ALL listed renewals (like last-paid-data.ts, R-2422), never one per row; every
 * read chunked by id (fetchAllRowsIn — no over-long URL) and paged (no silent 1,000-row cut):
 *   round 1 (together): quotes linked by renewal_subscription_id / add_seats_subscription_id; the
 *           subscriptions' own + renewal quotes by id; their subscription_billings rows;
 *   round 2 (together): the part proformas of those billing rows (quotes.subscription_billing_id);
 *           invoices raised from the round-1 quotes; invoices by id (billing / quote invoice_id).
 *   round 3 (together, R-2737): only for the documents the rows SHOW — the whole quotes' lines +
 *           period context (the invoice paper's "Subscription period") and the shown invoices'
 *           credit / debit notes (Cancelled · credit note). A failed round 3 only drops the
 *           period / credited words — the rows still load.
 * Read on the signed-in session: RLS keeps every row to this company. Keyed under ["quotes"] so
 * sending / revising a quote, Bill next part and recording a payment (they invalidate "quotes")
 * refresh the rows.
 * R-2740: readRenewalDocs is the same read as a plain function — the row drawer runs it for ONE
 * subscription with { all: true } (every quote + invoice) inside its own single query.
 */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn, RENEWALS_READ_CONCURRENCY } from "@/lib/ops/fetch-all";
import { noteTotalsByInvoice, type NoteAmountRow } from "@/lib/invoices/note-totals";
import {
  attachDocDetails, detailQuoteIds, lastDocsBySubscription, shownInvoiceIds,
  type DocBilling, type DocInvoice, type DocQuote, type DocQuoteDetail, type LastDocs, type LastDocsInput,
} from "./last-docs";

type SubRef = LastDocsInput["subs"][number];

/** PostgREST `in.(…)` list — quoted so a comma or dot never splits an id. */
const inList = (ids: readonly string[]) => `(${ids.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")})`;

const QUOTE_COLS = "id, status, payment_status, created_at, created_date, expires_date, invoice_id, renewal_subscription_id, add_seats_subscription_id, subscription_billing_id, superseded_by, revision_of, amount, currency, exchange_rate";
const INVOICE_COLS = "id, quote_id, invoice_date, status, amount, paid_amount, currency, created_at, due_date, net_payable, adjusted_advances, written_off_at, fx_rate";
const DETAIL_COLS = "id, line_items, is_renewal, is_extension, is_add_seats, is_one_off, extension_months, renewal_term_date, created_date";

/** The read's own copy of each subscription (deduped, sorted — a stable query key). */
export function docRefs(subs: readonly SubRef[]): SubRef[] {
  return [...new Map(subs.map((s) => [s.id, {
    id: s.id, quote_id: s.quote_id, renewal_quote_id: s.renewal_quote_id, start_date: s.start_date,
    plan: s.plan ?? null, domain: s.domain ?? null,   // R-2737: which invoice line is this row's
  }])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function useRenewalLastDocs(subs: readonly SubRef[]) {
  const qc = useQueryClient();
  const rows = docRefs(subs);
  const key = rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}:${s.plan ?? ""}:${s.domain ?? ""}`);
  return useQuery({
    queryKey: ["quotes", "renewal-last-docs", key],
    enabled: rows.length > 0,
    staleTime: 60_000,
    /* R-2765: rounds 1–2 come from the ONE shared read (Last paid uses the same rows) */
    queryFn: async () => docsFromRows(rows, await fetchRenewalDocRows(qc, rows)),
  });
}

/**
 * R-2765 (R-2742 PERF-2): rounds 1–2 below — the quotes, billing parts and invoices of the listed
 * renewals — are read ONCE and shared: Last docs and Last paid (last-paid-data.ts) both take them from
 * this cache entry (fetchQuery joins a read already in flight) instead of each reading the same
 * quotes / billings / invoices. Keyed under ["quotes"] like the docs, so sending / revising a quote,
 * Bill next part or a payment (they invalidate "quotes") reads them again.
 */
/** What rounds 1–2 read from each subscription. */
export interface DocRowRef { id: string; quote_id: string | null; renewal_quote_id: string | null }
export function docRowsKey(rows: readonly DocRowRef[]): readonly unknown[] {
  return ["quotes", "renewal-doc-rows", rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}`).sort()];
}
export function fetchRenewalDocRows(qc: QueryClient, rows: readonly DocRowRef[]): Promise<RenewalDocRows> {
  return qc.fetchQuery({
    queryKey: docRowsKey(rows),
    staleTime: 30_000,
    queryFn: () => readRenewalDocRows(rows, { concurrency: RENEWALS_READ_CONCURRENCY }),
  });
}

/** Rounds 1–2 of the read (see the header), as read — Last docs and Last paid each shape them their way. */
export interface RenewalDocRows {
  /** quotes linked by renewal / add-seats subscription id + the subscriptions' own and renewal quotes (+ drawer revisions) */
  round1: DocQuote[];
  /** R-2765 (Last paid): round 1 split — linked by renewal / add-seats subscription id, and the subscriptions' own + renewal quotes by id */
  viaSub: DocQuote[];
  own: DocQuote[];
  billings: DocBilling[];
  /** the billed parts' proformas (quotes.subscription_billing_id) */
  parts: DocQuote[];
  /** invoices raised from the round-1 quotes (every status) */
  byQuote: DocInvoice[];
  /** invoices by id (billing / quote invoice_id) */
  byId: DocInvoice[];
}

/** The batched read (see the header). `all` (R-2740 drawer): every linked quote + invoice, not only the row's. */
export async function readRenewalDocs(
  rows: readonly SubRef[],
  opts: {
    all?: boolean;
    /** R-2740 drawer: more quotes for round 1 (the revisions of what it found), read with these columns. */
    moreQuotes?: (found: readonly DocQuote[], cols: string) => Promise<DocQuote[]>;
  } = {},
): Promise<Map<string, LastDocs>> {
  return docsFromRows(rows, await readRenewalDocRows(rows, opts), opts);
}

/** R-2765: rounds 1–2 (see the header). `concurrency`: id chunks in flight per read (the page: 4). */
export async function readRenewalDocRows(
  rows: readonly DocRowRef[],
  opts: { moreQuotes?: (found: readonly DocQuote[], cols: string) => Promise<DocQuote[]>; concurrency?: number } = {},
): Promise<RenewalDocRows> {
  const supabase = createClient();
  const c = { concurrency: opts.concurrency };
  /* quotes.subscription_billing_id / subscription_billings.due_on (R-2044) are not in the generated types yet — the same untyped read as next-part-request.ts. */
  const loose = supabase as unknown as SupabaseClient;
  const subIds = rows.map((s) => s.id);
  const ownQuoteIds = [...new Set(rows.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((x): x is string => !!x))];

  const [viaSub, own, billings] = await Promise.all([
    fetchAllRowsIn<DocQuote, string>(subIds, (run, from, to) => loose
      .from("quotes")
      .select(QUOTE_COLS)
      .or(`renewal_subscription_id.in.${inList(run)},add_seats_subscription_id.in.${inList(run)}`)
      .order("id", { ascending: true })
      .range(from, to), { chunkSize: 100, ...c }),   // the id list is in the URL twice
    fetchAllRowsIn<DocQuote, string>(ownQuoteIds, (run, from, to) => loose
      .from("quotes")
      .select(QUOTE_COLS)
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
    fetchAllRowsIn<DocBilling, string>(subIds, (run, from, to) => loose
      .from("subscription_billings")
      .select("id, subscription_id, invoice_id, term_start, period_index, due_on, period_start, period_end")
      .in("subscription_id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
  ]);
  const round1 = [...viaSub, ...own];
  /* R-2740 drawer: the other revisions of these quotes (drawer-data.ts readRevisions) join round 1. */
  if (opts.moreQuotes) round1.push(...await opts.moreQuotes(round1, QUOTE_COLS));
  const quoteIds = [...new Set(round1.map((q) => q.id))];
  const invoiceIds = [...new Set([
    ...billings.map((b) => b.invoice_id),
    ...round1.map((q) => q.invoice_id),
  ].filter((x): x is string => !!x))];

  const [parts, byQuote, byId] = await Promise.all([
    fetchAllRowsIn<DocQuote, string>(billings.map((b) => b.id), (run, from, to) => loose
      .from("quotes")
      .select(QUOTE_COLS)
      .in("subscription_billing_id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
    fetchAllRowsIn<DocInvoice, string>(quoteIds, (run, from, to) => supabase
      .from("invoices")
      .select(INVOICE_COLS)
      .in("quote_id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
    fetchAllRowsIn<DocInvoice, string>(invoiceIds, (run, from, to) => supabase
      .from("invoices")
      .select(INVOICE_COLS)
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
  ]);
  return { round1, viaSub, own, billings, parts, byQuote, byId };
}

/** R-2765: the rows' documents from rounds 1–2, then round 3 (only for what the rows show). */
export async function docsFromRows(rows: readonly SubRef[], r: RenewalDocRows, opts: { all?: boolean } = {}): Promise<Map<string, LastDocs>> {
  const supabase = createClient();
  const loose = supabase as unknown as SupabaseClient;
  const { round1, billings, parts, byQuote, byId } = r;
  const quotes = [...new Map([...round1, ...parts].map((q) => [q.id, q])).values()];
  const docs = lastDocsBySubscription({ subs: rows, quotes, billings, invoices: [...byQuote, ...byId] }, { all: opts.all });

  const shownInvoices = shownInvoiceIds(docs);
  let read: [DocQuoteDetail[], NoteAmountRow[], NoteAmountRow[]];
  try {
    read = await Promise.all([
      fetchAllRowsIn<DocQuoteDetail, string>(detailQuoteIds(docs), (run, from, to) => loose
        .from("quotes")
        .select(DETAIL_COLS)
        .in("id", run)
        .order("id", { ascending: true })
        .range(from, to), { chunkSize: 100 }),   // line_items can be long; smaller pages
      fetchAllRowsIn<NoteAmountRow, string>(shownInvoices, (run, from, to) => supabase
        .from("credit_notes")
        .select("invoice_id, amount")
        .in("invoice_id", run)
        .order("id", { ascending: true })
        .range(from, to)),
      fetchAllRowsIn<NoteAmountRow, string>(shownInvoices, (run, from, to) => supabase
        .from("debit_notes")
        .select("invoice_id, amount")
        .in("invoice_id", run)
        .order("id", { ascending: true })
        .range(from, to)),
    ]);
  } catch (e) {
    /* only the period / credit-note words are lost — the rows keep their documents and states */
    console.warn("R-2737: renewal last-docs details not read", e);
    return attachDocDetails(docs, null, rows);
  }
  const [details, credits, debits] = read;
  return attachDocDetails(docs, { quotes: details, notes: noteTotalsByInvoice(credits, debits) }, rows);
}
