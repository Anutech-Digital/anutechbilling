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
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { noteTotalsByInvoice, type NoteAmountRow } from "@/lib/invoices/note-totals";
import {
  attachDocDetails, attachSendTimes, detailQuoteIds, lastDocsBySubscription, sendLogQuoteIds, shownInvoiceIds,
  type SendLogRow,
  liveTogetherLinks,
  type DocBilling, type DocInvoice, type DocQuote, type DocQuoteDetail, type LastDocs, type LastDocsInput, type TogetherLink,
} from "./last-docs";

type SubRef = LastDocsInput["subs"][number];

const QUOTE_COLS = "id, status, payment_status, created_at, created_date, expires_date, invoice_id, renewal_subscription_id, add_seats_subscription_id, subscription_billing_id, superseded_by, revision_of, amount, currency, exchange_rate";
/** R-2830: the part proformas also carry their lines — a together proforma names every member's part there (same query, no read per row). */
const PART_COLS = `${QUOTE_COLS}, line_items`;
const INVOICE_COLS = "id, quote_id, invoice_date, status, amount, paid_amount, currency, created_at, due_date, net_payable, adjusted_advances, written_off_at, fx_rate";
/** R-2870: renewal_quote_subscriptions (R-2847) — which subscriptions a together renewal quote renews. */
export const TOGETHER_LINK_COLS = "quote_id, subscription_id, renewal_term_date, subtotal, renewed_at, released_at";

const DETAIL_COLS = "id, line_items, is_renewal, is_extension, is_add_seats, is_one_off, extension_months, renewal_term_date, created_date";

/** The read's own copy of each subscription (deduped, sorted — a stable query key). */
export function docRefs(subs: readonly SubRef[]): SubRef[] {
  return [...new Map(subs.map((s) => [s.id, {
    id: s.id, quote_id: s.quote_id, renewal_quote_id: s.renewal_quote_id, start_date: s.start_date,
    plan: s.plan ?? null, domain: s.domain ?? null,   // R-2737: which invoice line is this row's
    term_months: s.term_months ?? null,               // R-2822: where a renewal quote's period starts
  }])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function useRenewalLastDocs(subs: readonly SubRef[]) {
  const qc = useQueryClient();
  const rows = docRefs(subs);
  const key = rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}:${s.plan ?? ""}:${s.domain ?? ""}:${s.term_months ?? ""}:${s.start_date ?? ""}`);
  return useQuery({
    queryKey: ["quotes", "renewal-last-docs", key],
    enabled: rows.length > 0,
    staleTime: 60_000,
    /* R-2765: rounds 1–2 come from the ONE shared read (Last paid uses the same rows) */
    queryFn: async () => docsFromRows(rows, await fetchRenewalDocRows(qc, rows), { concurrency: RENEWALS_READ_CONCURRENCY }),   // R-2855: round 3 side by side too
  });
}

/**
 * R-2765 (R-2742 PERF-2): rounds 1–2 below — the quotes, billing parts and invoices of the listed
 * renewals — are read ONCE and shared: Last docs and Last paid (last-paid-data.ts) both take them from
 * this cache entry (fetchQuery joins a read already in flight) instead of each reading the same
 * quotes / billings / invoices. Keyed under ["quotes"] like the docs, so sending / revising a quote,
 * Bill next part or a payment (they invalidate "quotes") reads them again.
 */
/** R-2765: id chunks in flight at once per read on the Renewals page (browser → PostgREST). */
export const RENEWALS_READ_CONCURRENCY = 4;
/** R-2855: subscription ids per "quotes linked to these subscriptions" request — one id list in the URL (~6k chars; 8k is the proxy's limit). */
const VIA_SUB_CHUNK = 150;

/** What rounds 1–2 read from each subscription. */
export interface DocRowRef { id: string; quote_id: string | null; renewal_quote_id: string | null }
export function docRowsKey(rows: readonly DocRowRef[]): readonly unknown[] {
  return ["quotes", "renewal-doc-rows", rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}`).sort()];
}
export function fetchRenewalDocRows(qc: QueryClient, rows: readonly DocRowRef[]): Promise<RenewalDocRows> {
  return qc.fetchQuery({
    queryKey: docRowsKey(rows),
    /* 0: every Last docs / Last paid refetch reads the rows again (as each did before) — two reads
       started together still share ONE request (a read in flight is joined) */
    staleTime: 0,
    queryFn: () => readRenewalDocRows(rows, { concurrency: RENEWALS_READ_CONCURRENCY }),
  });
}

/** Rounds 1–2 of the read (see the header), as read — Last docs and Last paid each shape them their way. */
export interface RenewalDocRows {
  /** round 1: quotes linked by renewal / add-seats subscription id */
  viaSub: DocQuote[];
  /** round 1: the subscriptions' own + renewal quotes by id (only the ones this person may read) */
  own: DocQuote[];
  /** round 1, drawer only: the revisions of those quotes (opts.moreQuotes) */
  more: DocQuote[];
  billings: DocBilling[];
  /** R-2870: the together-quote links of the listed subscriptions (released ones left out); their quotes are in `viaSub`. */
  links: TogetherLink[];
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

  /* R-2855: the quotes linked by subscription id are two plain .in() reads (renewal / add-seats), side by side.
     One .or() put the id list in the URL twice, so only 60 ids fit a request (R-2841: 100 ids = ~8.2k chars, local
     Kong answers 414 → whole column "Couldn't load") — staging's 786 subscriptions = 14 requests, 4 trips before
     round 2 could start. Now 150 ids a request (~6k chars, well under the limit) = 2 trips. Same rows: the two
     answers joined, a quote linked both ways kept once, in id order as before. */
  const viaSubBy = (col: "renewal_subscription_id" | "add_seats_subscription_id") =>
    fetchAllRowsIn<DocQuote, string>(subIds, (run, from, to) => loose
      .from("quotes")
      .select(QUOTE_COLS)
      .in(col, run)
      .order("id", { ascending: true })
      .range(from, to), { chunkSize: VIA_SUB_CHUNK, ...c });
  const [viaRenewal, viaSeats, own, billings] = await Promise.all([
    viaSubBy("renewal_subscription_id"),
    viaSubBy("add_seats_subscription_id"),
    fetchAllRowsIn<DocQuote, string>(ownQuoteIds, (run, from, to) => loose
      .from("quotes")
      .select(QUOTE_COLS)
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
    fetchAllRowsIn<DocBilling, string>(subIds, (run, from, to) => loose
      .from("subscription_billings")
      .select("id, subscription_id, invoice_id, term_start, period_index, due_on, period_start, period_end, taxable_amount")
      .in("subscription_id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
  ]);
  /* R-2870: a quote billed together names its members in renewal_quote_subscriptions (the quote's own renewal_subscription_id
     is empty, and paying clears the subscription's renewal_quote_id) — one more batched read, then the quotes not read yet. A failed
     link read leaves the rows as they were (the table is older than this read on a server without R-2847). */
  const links = liveTogetherLinks(await fetchAllRowsIn<TogetherLink, string>(subIds, (run, from, to) => loose
    .from("renewal_quote_subscriptions")
    .select(TOGETHER_LINK_COLS)
    .in("subscription_id", run)
    .order("id", { ascending: true })
    .range(from, to), c).catch((e: unknown) => { console.warn("R-2870: together links not read", e); return [] as TogetherLink[]; }));
  const known = new Set([...viaRenewal, ...viaSeats, ...own].map((q) => q.id));
  const linkQuotes = await fetchAllRowsIn<DocQuote, string>([...new Set(links.map((l) => l.quote_id))].filter((id) => !known.has(id)), (run, from, to) => loose
    .from("quotes")
    .select(QUOTE_COLS)
    .in("id", run)
    .order("id", { ascending: true })
    .range(from, to), c);
  const viaSub = [...new Map([...viaRenewal, ...viaSeats, ...linkQuotes].map((q) => [q.id, q])).values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /* R-2740 drawer: the other revisions of these quotes (drawer-data.ts readRevisions) join round 1. */
  const more = opts.moreQuotes ? await opts.moreQuotes([...viaSub, ...own], QUOTE_COLS) : [];
  const round1 = [...viaSub, ...own, ...more];
  const quoteIds = [...new Set(round1.map((q) => q.id))];
  const invoiceIds = [...new Set([
    ...billings.map((b) => b.invoice_id),
    ...round1.map((q) => q.invoice_id),
  ].filter((x): x is string => !!x))];

  const [parts, byQuote, byId] = await Promise.all([
    fetchAllRowsIn<DocQuote, string>(billings.map((b) => b.id), (run, from, to) => loose
      .from("quotes")
      .select(PART_COLS)
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
  return { viaSub, own, more, billings, links, parts, byQuote, byId };
}

/** R-2765: the rows' documents from rounds 1–2, then round 3 (only for what the rows show). */
export async function docsFromRows(rows: readonly SubRef[], r: RenewalDocRows, opts: { all?: boolean; concurrency?: number } = {}): Promise<Map<string, LastDocs>> {
  const supabase = createClient();
  /* R-2855: round 3 read its id chunks one after another (R-2765 only did rounds 1–2) — on staging's 786
     subscriptions that was 16 requests in a row for the quote lines alone, and the Status chip waits for them.
     With `concurrency` (the page: 4) each of the three reads goes 4 chunks at a time; the quote lines are read
     200 ids a request like every other read here (it was 100 "for smaller pages": 200 quotes' lines are a few
     hundred KB, and half the requests). The drawer's one-subscription read passes none — one chunk, as before. */
  const c = { concurrency: opts.concurrency };
  const loose = supabase as unknown as SupabaseClient;
  const { viaSub, own, more, billings, links, parts, byQuote, byId } = r;
  const quotes = [...new Map([...viaSub, ...own, ...more, ...parts].map((q) => [q.id, q])).values()];
  const docs = lastDocsBySubscription({ subs: rows, quotes, billings, invoices: [...byQuote, ...byId], links }, { all: opts.all });

  const shownInvoices = shownInvoiceIds(docs);
  let read: [DocQuoteDetail[], NoteAmountRow[], NoteAmountRow[]];
  try {
    read = await Promise.all([
      fetchAllRowsIn<DocQuoteDetail, string>(detailQuoteIds(docs), (run, from, to) => loose
        .from("quotes")
        .select(DETAIL_COLS)
        .in("id", run)
        .order("id", { ascending: true })
        .range(from, to), c),
      fetchAllRowsIn<NoteAmountRow, string>(shownInvoices, (run, from, to) => supabase
        .from("credit_notes")
        .select("invoice_id, amount")
        .in("invoice_id", run)
        .order("id", { ascending: true })
        .range(from, to), c),
      fetchAllRowsIn<NoteAmountRow, string>(shownInvoices, (run, from, to) => supabase
        .from("debit_notes")
        .select("invoice_id, amount")
        .in("invoice_id", run)
        .order("id", { ascending: true })
        .range(from, to), c),
    ]);
  } catch (e) {
    /* only the period / credit-note words are lost — the rows keep their documents and states */
    console.warn("R-2737: renewal last-docs details not read", e);
    return attachDocDetails(docs, null, rows);
  }
  const [details, credits, debits] = read;
  const withDetails = attachDocDetails(docs, { quotes: details, notes: noteTotalsByInvoice(credits, debits) }, rows);
  return opts.all ? withSendTimes(withDetails) : withDetails;
}

/**
 * R-2822 (drawer only): when the app emailed each quote with the customer — quote_send_log, one read for all of
 * them. A failed read leaves the time unknown ("Sent", never "Marked sent by hand": that would be a guess).
 */
async function withSendTimes(docs: Map<string, LastDocs>): Promise<Map<string, LastDocs>> {
  const ids = sendLogQuoteIds(docs);
  if (!ids.length) return docs;
  try {
    const log = await fetchAllRowsIn<SendLogRow, string>(ids, (run, from, to) => (createClient() as unknown as SupabaseClient)
      .from("quote_send_log")
      .select("quote_id, status, sent_at")
      .in("quote_id", run)
      .order("sent_at", { ascending: true })
      .range(from, to));
    return attachSendTimes(docs, log);
  } catch (e) {
    console.warn("R-2822: renewal drawer send log not read", e);
    return docs;
  }
}
