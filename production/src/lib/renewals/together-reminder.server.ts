/**
 * R-2852 — reads which renewal quotes are billed TOGETHER (R-2847's renewal_quote_subscriptions),
 * for the renewals cron and Send now. See together-reminder.ts for the rule.
 *
 * Only LIVE link rows count (released_at null — a cancelled / expired quote's rows are history) and
 * only quotes with 2+ of them. A database without the table yet (42P01 / PGRST205) has no together
 * quotes: an empty map, never an error. Any other failure is thrown — the caller must not guess
 * (guessing "single" would email the whole quote once per member again).
 */
import { chunk, uniq } from "@/lib/ops/p-limit";
import type { TogetherMember, TogetherQuote } from "./together-reminder";

const CHUNK = 200;

type Res = PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }>;
/** The two reads this needs — any supabase-js client fits (admin or cookie). */
export interface TogetherReadClient {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: string[]): Res & { is(col: string, val: null): Res };
    };
  };
}

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

interface LinkRow { quote_id: string; subscription_id: string; renewal_term_date: string; extension_months: number | null; line_no: number | null; seats: number | null }
interface SubRow { id: string; plan: string | null; seats: number | null; start_date: string | null; term_months: number | null }

/** Together quotes among `quoteIds` (2+ live link rows), keyed by quote id. Quote ids are unique across tenants. */
export async function readTogetherQuotes(
  supabase: TogetherReadClient,
  quoteIds: readonly (string | null | undefined)[],
): Promise<Map<string, TogetherQuote>> {
  const ids = uniq(quoteIds.filter((q): q is string => typeof q === "string" && q.length > 0));
  const out = new Map<string, TogetherQuote>();
  if (ids.length === 0) return out;

  const links: LinkRow[] = [];
  for (const part of chunk(ids, CHUNK)) {
    const { data, error } = await supabase
      .from("renewal_quote_subscriptions")
      .select("quote_id, subscription_id, renewal_term_date, extension_months, line_no, seats")
      .in("quote_id", part)
      .is("released_at", null);
    if (error) {
      if (MISSING_TABLE.has(error.code ?? "")) return out;
      throw new Error(`renewal_quote_subscriptions: ${error.message}`);
    }
    links.push(...((data ?? []) as unknown as LinkRow[]));
  }

  const byQuote = new Map<string, LinkRow[]>();
  for (const l of links) byQuote.set(l.quote_id, [...(byQuote.get(l.quote_id) ?? []), l]);
  const together = [...byQuote.entries()].filter(([, rows]) => rows.length >= 2);
  if (together.length === 0) return out;

  const subIds = uniq(together.flatMap(([, rows]) => rows.map((r) => r.subscription_id)));
  const subs = new Map<string, SubRow>();
  for (const part of chunk(subIds, CHUNK)) {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id, plan, seats, start_date, term_months")
      .in("id", part);
    if (error) throw new Error(`subscriptions (together quote members): ${error.message}`);
    for (const s of (data ?? []) as unknown as SubRow[]) subs.set(s.id, s);
  }

  for (const [quoteId, rows] of together) {
    const members: TogetherMember[] = rows.map((r) => {
      const s = subs.get(r.subscription_id);
      return {
        subscriptionId:  r.subscription_id,
        renewalTermDate: String(r.renewal_term_date).slice(0, 10),
        extensionMonths: r.extension_months ?? 12,
        lineNo:          r.line_no ?? 0,
        seats:           r.seats ?? s?.seats ?? null,
        plan:            s?.plan ?? "Subscription",
        startDate:       s?.start_date ?? null,
        termMonths:      s?.term_months ?? null,
      };
    });
    out.set(quoteId, { quoteId, members });
  }
  return out;
}
