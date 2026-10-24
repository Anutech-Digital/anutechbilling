/**
 * R-1621 — the per-customer and per-subscription grace overrides, read for a set of rows.
 *
 *   customers.trusted_grace_days   a trusted customer's own grace (owner/manager set it)
 *   subscriptions.grace_until      "+N days" the owner gave this term
 *   subscriptions.grace_task_for   the term whose "Stop service" task is already raised
 *
 * The columns arrive with migration 20261023131000. Code can reach a server before that
 * migration does (R-1721: new code ran an hour without 4 migrations), and a select naming a
 * column the database does not have fails the WHOLE read — the renewals cron would stop
 * reminding everyone. So these are read separately, and "column does not exist" (42703)
 * means "no overrides yet": the company grace applies, exactly as before this card.
 * Any other error is thrown.
 *
 * The columns are newer than the generated types (database.types.ts is shared), hence the
 * narrow untyped handle.
 */
import { fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";

export interface GraceOverrides {
  trustedByCustomer: Map<string, number | null>;
  bySubscription:    Map<string, { graceUntil: string | null; taskFor: string | null }>;
  /** False when the migration is not on this database yet. */
  available:         boolean;
}

type Loose = {
  from: (t: string) => {
    select: (cols: string) => {
      in: (col: string, ids: string[]) => {
        order: (col: string, o: { ascending: boolean }) => {
          range: (from: number, to: number) => PageQuery<Record<string, unknown>>;
        };
      };
    };
  };
};

/** PostgREST / Postgres "undefined column" — the migration has not reached this database. */
export function isMissingColumn(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  const msg = String((e as { message?: unknown }).message ?? "");
  return code === "42703" || code === "PGRST204" || /column .* does not exist/i.test(msg);
}

export async function readGraceOverrides(
  client: unknown,
  subscriptionIds: readonly string[],
  customerIds: readonly (string | null | undefined)[],
): Promise<GraceOverrides> {
  const db = client as Loose;
  const out: GraceOverrides = { trustedByCustomer: new Map(), bySubscription: new Map(), available: true };
  try {
    const custs = await fetchAllRowsIn(customerIds, (ids, from, to) => db
      .from("customers").select("id, trusted_grace_days").in("id", ids)
      .order("id", { ascending: true }).range(from, to));
    for (const c of custs) out.trustedByCustomer.set(String(c.id), (c.trusted_grace_days as number | null) ?? null);

    const subs = await fetchAllRowsIn(subscriptionIds, (ids, from, to) => db
      .from("subscriptions").select("id, grace_until, grace_task_for").in("id", ids)
      .order("id", { ascending: true }).range(from, to));
    for (const s of subs) {
      out.bySubscription.set(String(s.id), {
        graceUntil: (s.grace_until as string | null) ?? null,
        taskFor:    (s.grace_task_for as string | null) ?? null,
      });
    }
  } catch (e) {
    if (isMissingColumn(e)) {
      return { trustedByCustomer: new Map(), bySubscription: new Map(), available: false };
    }
    throw e;
  }
  return out;
}
