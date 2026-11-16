"use client";
/**
 * R-2870 — the together-quote links (renewal_quote_subscriptions, R-2847) of the listed subscriptions, each with its quote
 * embedded (quote_id → quotes), in the SAME first batched round as the other quote reads: no extra trip. Kept out of
 * last-docs-data.ts so that file's read count stays what the R-2737 / R-2748 guards pin (each chunk of ids is one read).
 * A failed read leaves the rows as they were (a server without R-2847 has no such table); a quote this login may not read
 * comes back null and is left out (its link still names the subscription, so Last paid can still find the payments).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { liveTogetherLinks, type DocQuote, type TogetherLink } from "./last-docs";

export const TOGETHER_LINK_COLS = "quote_id, subscription_id, renewal_term_date, subtotal, renewed_at, released_at";

export async function readTogetherLinks(
  loose: SupabaseClient, subIds: readonly string[], quoteCols: string, opts: { chunkSize: number; concurrency?: number },
): Promise<{ links: TogetherLink[]; quotes: DocQuote[] }> {
  try {
    const rows = await fetchAllRowsIn<TogetherLink & { quotes: DocQuote | null }, string>(subIds, (run, from, to) => loose
      .from("renewal_quote_subscriptions")
      .select(`${TOGETHER_LINK_COLS}, quotes(${quoteCols})`)
      .in("subscription_id", run)
      .order("id", { ascending: true })
      .range(from, to), opts);
    const live = liveTogetherLinks(rows);
    return {
      links: live.map(({ quotes: _q, ...l }) => l),
      quotes: [...new Map(live.flatMap((l) => (l.quotes ? [[l.quotes.id, l.quotes] as const] : []))).values()],
    };
  } catch (e) {
    console.warn("R-2870: together links not read", e);
    return { links: [], quotes: [] };
  }
}
