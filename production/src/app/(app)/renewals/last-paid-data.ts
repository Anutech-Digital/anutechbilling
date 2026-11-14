"use client";
/**
 * R-2422 — the batched read behind each Renewals row's "Last paid" (rules: ./last-paid.ts).
 *
 * ONE query set for ALL listed renewals (the page's whole ≤90-day list, so switching tab or tile
 * does not read again), never one per row. Each read is chunked by id (fetchAllRowsIn — no
 * over-long URL) and paged (no silent 1,000-row cut); independent reads run side by side:
 *   1. quotes linked to these subscriptions (renewal_subscription_id / add_seats_subscription_id),
 *      the subscriptions' own quotes (for their invoice_id) and instalment invoices
 *      (subscription_billings) — together;
 *   2. invoices raised from those quotes (void ones left out) and every subscription made from
 *      them (one quote can make several — "covers N subscriptions") — together;
 *      R-2752: also the billed parts' proformas (quotes.subscription_billing_id) — same round;
 *   3. payments on those quotes and on those invoices, status 'received' only (refunds are
 *      'refunded'; refunded_at is checked again in last-paid.ts) — together.
 * Read on the signed-in browser session: RLS keeps every row to this company (and to customers
 * this person may see). Keyed under ["payments"] so recording a payment refreshes the rows.
 * R-2740: readRenewalLastPaid is the same read as a plain function — the row drawer runs it for
 * ONE subscription with { historySize: Infinity } (every payment) inside its own single query.
 * R-2765 (R-2742 PERF-2): rounds 1 and 2 (the linked quotes, billing parts, invoices) are no longer
 * read here — they are Last docs' rounds 1–2 (last-docs-data.ts readRenewalDocRows), read ONCE for
 * both; this file reads only what Last docs does not: the subscriptions made from those quotes and
 * the payments (by quote and by invoice), 4 id chunks at a time.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn, RENEWALS_READ_CONCURRENCY } from "@/lib/ops/fetch-all";
import { fetchRenewalDocRows, readRenewalDocRows, type RenewalDocRows } from "./last-docs-data";
import { lastPaidBySubscription, linkedDocs, type LastPaid, type LastPaidInput } from "./last-paid";

type SubRef = LastPaidInput["subs"][number];
type QuoteRow = LastPaidInput["linkedQuotes"][number];
type PaymentRow = LastPaidInput["payments"][number];

const PAYMENT_COLS = "id, amount, method, status, received_at, refunded_at, quote_id, invoice_id";

export function useRenewalLastPaid(subs: readonly SubRef[]) {
  const qc = useQueryClient();
  const rows = [...new Map(subs.map((s) => [s.id, { id: s.id, quote_id: s.quote_id, renewal_quote_id: s.renewal_quote_id }])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  const key = rows.map((s) => `${s.id}:${s.quote_id ?? ""}:${s.renewal_quote_id ?? ""}`);
  return useQuery({
    queryKey: ["payments", "renewal-last-paid", key],
    enabled: rows.length > 0,
    staleTime: 60_000,
    /* R-2765: the quotes / billings / invoices from Last docs' shared read — not read twice */
    queryFn: async () => lastPaidFromDocRows(rows, await fetchRenewalDocRows(qc, rows), { concurrency: RENEWALS_READ_CONCURRENCY }),
  });
}

/** The batched read (see the header). `historySize` (R-2740 drawer): how many payments per subscription (default 3). */
export async function readRenewalLastPaid(rows: readonly SubRef[], opts: { historySize?: number } = {}): Promise<Map<string, LastPaid>> {
  return lastPaidFromDocRows(rows, await readRenewalDocRows(rows), opts);
}

/**
 * R-2765: Last paid from Last docs' rounds 1–2 — the same quotes / billings / invoices the old read
 * asked for (own quotes count only for their invoice_id; void invoices left out), then the
 * subscriptions made from those quotes and the received payments.
 */
export async function lastPaidFromDocRows(
  rows: readonly SubRef[], docRows: RenewalDocRows, opts: { historySize?: number; concurrency?: number } = {},
): Promise<Map<string, LastPaid>> {
  const supabase = createClient();
  const c = { concurrency: opts.concurrency };
  const viaSub: QuoteRow[] = docRows.viaSub.map((q) => ({
    id: q.id, renewal_subscription_id: q.renewal_subscription_id ?? null, add_seats_subscription_id: q.add_seats_subscription_id ?? null, invoice_id: q.invoice_id ?? null,
  }));
  /* Own quotes are read only for their invoice_id; their sub links come from `rows`. */
  const own = docRows.own.map((q) => ({ id: q.id, invoice_id: q.invoice_id ?? null, renewal_subscription_id: null, add_seats_subscription_id: null }));
  /* R-2752: a billed part's proforma links to its subscription through subscription_billing_id */
  const parts = docRows.parts.map((q) => ({ id: q.id, invoice_id: q.invoice_id ?? null, subscription_billing_id: q.subscription_billing_id ?? null, renewal_subscription_id: null, add_seats_subscription_id: null }));
  const billings = docRows.billings.map((b) => ({ id: b.id, subscription_id: b.subscription_id, invoice_id: b.invoice_id ?? null }));
  const baseQuoteIds = [...new Set([...own.map((q) => q.id), ...viaSub.map((q) => q.id)])];
  const base = new Set(baseQuoteIds);
  /* invoices raised from those quotes, void ones left out (the old round 2) */
  const invoices = docRows.byQuote
    .filter((i) => i.status !== "void" && !!i.quote_id && base.has(i.quote_id))
    .map((i) => ({ id: i.id, quote_id: i.quote_id ?? null }));
  const linkedQuotes = [...viaSub, ...own, ...parts];
  const quoteIds = [...new Set([...baseQuoteIds, ...parts.map((q) => q.id)])];

  const [quoteSiblings, byQuote] = await Promise.all([
    fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(baseQuoteIds, (run, from, to) => supabase
      .from("subscriptions")
      .select("id, quote_id")
      .in("quote_id", run)
      .order("id", { ascending: true })
      .range(from, to), c),
    fetchAllRowsIn<PaymentRow, string>(quoteIds, (run, from, to) => supabase
      .from("payments")
      .select(PAYMENT_COLS)
      .in("quote_id", run)
      .eq("status", "received")
      .order("id", { ascending: true })
      .range(from, to), c),
  ]);
  const { invoiceSubs } = linkedDocs({ subs: rows, quoteSiblings, linkedQuotes, billings, invoices });
  const byInvoice = await fetchAllRowsIn<PaymentRow, string>([...invoiceSubs.keys()], (run, from, to) => supabase
    .from("payments")
    .select(PAYMENT_COLS)
    .in("invoice_id", run)
    .eq("status", "received")
    .order("id", { ascending: true })
    .range(from, to), c);
  return lastPaidBySubscription({ subs: rows, quoteSiblings, linkedQuotes, billings, invoices, payments: [...byQuote, ...byInvoice] }, opts);
}
