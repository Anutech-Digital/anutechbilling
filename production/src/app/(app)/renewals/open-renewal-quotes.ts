/**
 * R-453: a subscription whose renewal quote already exists shows "Open quote", never
 * "Generate quote" again.
 *
 * The row decides from `subscriptions.renewal_quote_id`. Abhishek, Scenario 9 (Gupta
 * Infotech): after Q-DEMO-27-0009 was generated, the row still offered "Generate quote" —
 * one more click and the customer gets a second renewal quote. The link-back write
 * (lib/renewals/create-renewal-quote.ts) is not checked for errors, so a quote can exist
 * with the column still empty.
 *
 * So the page also reads the open renewal quotes themselves. Every renewal quote the app
 * makes carries "subscription <id>" in its notes (operator button and cron both), which
 * names the subscription exactly — no guessing by customer name.
 */
import type { Subscription } from "@/lib/supabase/database.types";

export interface OpenRenewalQuote {
  id: string;
  notes: string | null;
}

const SUB_ID = /subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** subscription id → its open renewal quote id (newest first wins). */
export function openRenewalQuoteMap(quotes: readonly OpenRenewalQuote[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const q of quotes) {
    const m = q.notes?.match(SUB_ID);
    if (m && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), q.id);
  }
  return out;
}

/** The subscription with its renewal quote filled in from the open quotes when the column is empty. */
export function withRenewalQuote<T extends Pick<Subscription, "id" | "renewal_quote_id">>(sub: T, map: Map<string, string>): T {
  if (sub.renewal_quote_id) return sub;
  const q = map.get(sub.id.toLowerCase());
  return q ? { ...sub, renewal_quote_id: q } : sub;
}
