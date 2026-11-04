/**
 * R-2411 — which customers' automatic payment reminders are ON HOLD today (a promise to pay with
 * its date ahead, or an open dispute). The rule is followup-rules.ts collectionHold; this only
 * reads payment_followups for the dunning cron, in one paged pass.
 *
 * TENANT SAFETY: the cron runs as service role, so the tenant is checked here — a row counts only
 * for the (tenant, customer) pair it was written in. Keyed by holdKey(tenant, customer).
 *
 * A failed read THROWS: the caller stops the run like its other prefetches (lib/ops/fetch-all
 * house rule) rather than emailing someone who promised or disputed.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { collectionHold, DISPUTED, DISPUTE_RESOLVED, type CollectionHold, type HoldRow } from "./followup-rules";

type Db = ReturnType<typeof createAdminClient>;
type Row = HoldRow & { tenant_id: string; customer_id: string };

const COLS = "id, tenant_id, customer_id, kind, note, outcome, promised_on, promised_amount, created_at";

export const holdKey = (tenantId: string, customerId: string) => `${tenantId}:${customerId}`;

export async function loadCollectionHolds(
  supabase: Db,
  pairs: readonly { tenantId: string; customerId: string | null }[],
  today: string,
): Promise<Map<string, CollectionHold>> {
  const wanted = new Set(pairs.filter((p) => p.customerId).map((p) => holdKey(p.tenantId, p.customerId!)));
  const out = new Map<string, CollectionHold>();
  if (wanted.size === 0) return out;
  const customerIds = pairs.map((p) => p.customerId);

  /* Only the rows that can hold: promises, and dispute / resolved entries. Two filtered reads
     instead of every call and note of every customer. */
  const [promises, disputes] = await Promise.all([
    fetchAllRowsIn<Row, string>(customerIds, (ids, from, to) => supabase
      .from("payment_followups").select(COLS)
      .in("customer_id", ids).not("promised_on", "is", null)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRowsIn<Row, string>(customerIds, (ids, from, to) => supabase
      .from("payment_followups").select(COLS)
      .in("customer_id", ids).in("outcome", [DISPUTED, DISPUTE_RESOLVED])
      .order("id", { ascending: true }).range(from, to)),
  ]);

  const byKey = new Map<string, Row[]>();
  for (const r of [...promises, ...disputes]) {
    const key = holdKey(r.tenant_id, r.customer_id);
    if (!wanted.has(key)) continue; // another company's row for the same customer id
    const list = byKey.get(key);
    if (list) list.push(r); else byKey.set(key, [r]);
  }
  for (const [key, rows] of byKey) {
    const hold = collectionHold(rows, today);
    if (hold) out.set(key, hold);
  }
  return out;
}
