"use client";
/**
 * R-2866 — the ONE batched read behind the Renewals rows' quote hover card (and the pop-up's lines): the product
 * lines of the quotes the rows on screen name, with what their periods need. Never a query per row or per hover:
 *   round 1: those quotes' lines + period context (chunked by id, paged — fetchAllRowsIn);
 *   round 2 (together): the billed parts their lines name (a part proforma's period) and the subscriptions
 *            their lines / renewal name (where a renewal's next term starts).
 * Read on the signed-in session — RLS keeps every row to this company. Keyed under ["quotes"], so sending /
 * revising a quote or recording a payment (they invalidate "quotes") reads it again. Rules: ./quote-peek.ts.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { peekLines, peekNeeds, type PeekBilling, type PeekLine, type PeekQuoteRow, type PeekSub } from "./quote-peek";

export const PEEK_QUOTE_COLS = "id, line_items, is_renewal, is_extension, is_add_seats, is_one_off, extension_months, renewal_term_date, created_date, domain, subscription_billing_id, renewal_subscription_id";

/** A row's quote and the subscription the row is for (the renewed one, when the quote does not name it). */
export interface PeekRef { quoteId: string; sub?: PeekSub | null }

export async function readQuoteLines(refs: readonly PeekRef[]): Promise<Map<string, PeekLine[]>> {
  /* quotes.subscription_billing_id is not in the generated types yet — the same untyped read as last-docs-data.ts */
  const db = createClient() as unknown as SupabaseClient;
  const ids = [...new Set(refs.map((r) => r.quoteId))].sort();
  const quotes = await fetchAllRowsIn<PeekQuoteRow, string>(ids, (run, from, to) => db
    .from("quotes").select(PEEK_QUOTE_COLS).in("id", run).order("id", { ascending: true }).range(from, to));
  const needs = peekNeeds(quotes);
  const [billings, subs] = await Promise.all([
    fetchAllRowsIn<PeekBilling, string>(needs.billingIds, (run, from, to) => db
      .from("subscription_billings").select("id, subscription_id, period_start, period_end").in("id", run).order("id", { ascending: true }).range(from, to)),
    fetchAllRowsIn<PeekSub, string>(needs.subIds, (run, from, to) => db
      .from("subscriptions").select("id, domain, start_date, term_months").in("id", run).order("id", { ascending: true }).range(from, to)),
  ]);
  const billingById = new Map(billings.map((b) => [b.id, b]));
  const subById = new Map(subs.map((s) => [s.id, s]));
  const rowSub = new Map(refs.map((r) => [r.quoteId, r.sub ?? null]));
  return new Map(quotes.map((q) => [q.id, peekLines(q, billingById, subById, rowSub.get(q.id))]));
}

/** The lines of every quote in `refs`, by quote id — one read for all of them. Empty → no read. */
export function useRowQuoteLines(refs: readonly PeekRef[]) {
  const key = [...new Set(refs.map((r) => `${r.quoteId}:${r.sub?.id ?? ""}:${r.sub?.start_date ?? ""}:${r.sub?.term_months ?? ""}`))].sort();
  return useQuery({
    queryKey: ["quotes", "renewal-row-quote-lines", key],
    enabled: key.length > 0,
    staleTime: 60_000,
    placeholderData: (prev: Map<string, PeekLine[]> | undefined) => prev,
    queryFn: () => readQuoteLines(refs),
  });
}
