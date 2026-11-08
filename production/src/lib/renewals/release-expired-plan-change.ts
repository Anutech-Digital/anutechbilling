/**
 * R-2590 (c): an unpaid Change plan quote (R-2227) whose validity ended keeps the subscription's
 * renewal_quote_id — so the renewals cron would treat it as the renewal quote (existingQuoteId) and
 * Change plan / Extend / Add seats said "already has an open quote" for ever.
 *
 * The renewals cron calls this first, for each tenant it is allowed to run (R-897 gate), and drops
 * the released links from the rows it already read. The rule lives in SQL
 * (release_expired_plan_change_quotes, migration *_r2590_expired_plan_change_release.sql): status
 * becomes 'expired', the link is cleared; money on the quote keeps it linked.
 */

export interface ReleasedPlanChange {
  subscription_id: string;
  quote_id: string;
}

export interface ReleaseResult {
  released: ReleasedPlanChange[];
  errors: { tenantId: string; message: string }[];
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Tenants worth asking: those with at least one subscription that has a linked quote. */
export function tenantsWithLinkedQuote(subs: { tenant_id: string; renewal_quote_id: string | null }[]): string[] {
  return [...new Set(subs.filter((s) => s.renewal_quote_id).map((s) => s.tenant_id))];
}

export async function releaseExpiredPlanChanges(supabase: RpcClient, tenantIds: string[]): Promise<ReleaseResult> {
  const out: ReleaseResult = { released: [], errors: [] };
  for (const tenantId of tenantIds) {
    const { data, error } = await supabase.rpc("release_expired_plan_change_quotes", { p_tenant_id: tenantId });
    if (error) {
      out.errors.push({ tenantId, message: error.message });
      continue;
    }
    for (const row of (Array.isArray(data) ? data : []) as ReleasedPlanChange[]) {
      if (row?.subscription_id && row?.quote_id) out.released.push({ subscription_id: row.subscription_id, quote_id: row.quote_id });
    }
  }
  return out;
}

/** Clears the released links on rows already read, so this run does not reuse them. */
export function dropReleasedLinks<T extends { id: string; renewal_quote_id: string | null }>(subs: T[], released: ReleasedPlanChange[]): void {
  const byId = new Map(released.map((r) => [r.subscription_id, r.quote_id]));
  for (const s of subs) {
    if (s.renewal_quote_id && byId.get(s.id) === s.renewal_quote_id) s.renewal_quote_id = null;
  }
}
