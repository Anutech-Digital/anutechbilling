/**
 * R-2661 — zoho_api_day_calls (migration 20261113162000) through the server's admin client: the sink
 * behind each tenant's day meter (zoho-day-budget.ts) and the read the dialogs' "Zoho calls today"
 * line uses. The admin client bypasses RLS, so EVERY read and write is filtered by `tenantId` — the
 * signed-in user's own row (routes) or the run row (cron), never a browser (CLAUDE.md §17c).
 * One meter per tenant per app instance (memory): its count carries across requests; the RPC's answer
 * (the total across instances) keeps it right.
 */
import type { createAdminClientFor } from "@/lib/supabase/server";
import { createDayMeter, istDayOf, zohoDayBudget, type DayBudgetState, type DayCallsRow, type DayCallsSink, type DayMeter } from "./zoho-day-budget";
import { nextIstMidnight } from "./zoho-limit";

type Db = ReturnType<typeof createAdminClientFor>;
type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;

/** The DB's `date` → YYYY-MM-DD (PostgREST sends it as a string already). */
const dayText = (v: unknown): string => String(v ?? "").slice(0, 10);

export function supabaseDayCallsSink(db: Db, tenantId: string): DayCallsSink {
  return {
    async read(day) {
      const r = await (db.from("zoho_api_day_calls").select("day, calls, limit_hit_at").eq("tenant_id", tenantId).eq("day", day).limit(1) as Res<Array<Record<string, unknown>>>);
      if (r.error) throw new Error(r.error.message ?? "Could not read the Zoho day count.");
      const row = r.data?.[0];
      if (!row) return null;
      return { day: dayText(row.day), calls: Number(row.calls ?? 0), limitHitAt: (row.limit_hit_at as string | null) ?? null } satisfies DayCallsRow;
    },
    async add(day, calls, refusal) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await ((db as any).rpc("zoho_day_calls_add", { p_tenant: tenantId, p_day: day, p_calls: calls, p_limit_hit: refusal !== null, p_refusal: refusal }) as Res<Array<{ total: number; hit_at: string | null }> | { total: number; hit_at: string | null }>);
      if (r.error) throw new Error(r.error.message ?? "Could not count the Zoho call.");
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!row) throw new Error("Could not count the Zoho call.");
      return { day, calls: Number(row.total ?? 0), limitHitAt: row.hit_at ?? null };
    },
  };
}

const meters = new Map<string, DayMeter>();

/** This tenant's meter on this app instance (made once; the first caller's admin client serves it). */
export function tenantDayMeter(db: Db, tenantId: string): DayMeter {
  let m = meters.get(tenantId);
  if (!m) { m = createDayMeter(tenantId, supabaseDayCallsSink(db, tenantId)); meters.set(tenantId, m); }
  return m;
}

/** Tests: forget every tenant's meter. */
export function forgetTenantDayMeters(): void {
  meters.clear();
}

/** Today's count for the dialogs' line — read from the database (not this instance's memory). */
export async function readDayCalls(db: Db, tenantId: string, nowMs: number = Date.now()): Promise<DayBudgetState> {
  const budget = zohoDayBudget();
  const day = istDayOf(nowMs);
  const row = await supabaseDayCallsSink(db, tenantId).read(day);
  const calls = row?.calls ?? 0;
  const limitHitAt = row?.limitHitAt ?? null;
  return { day, calls, budget, limitHitAt, spent: limitHitAt !== null || calls >= budget, retryAt: nextIstMidnight(nowMs) };
}
