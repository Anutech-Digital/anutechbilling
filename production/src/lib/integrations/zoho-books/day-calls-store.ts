/**
 * R-2661 — zoho_api_day_calls (migration 20261116160051) through the server's admin client: the sink
 * behind each tenant's day meter (zoho-day-budget.ts) and the read the dialogs' "Zoho calls today"
 * line uses. The admin client bypasses RLS, so EVERY read and write is filtered by `tenantId` — the
 * signed-in user's own row (routes) or the run row (cron), never a browser (CLAUDE.md §17c).
 * One meter per tenant per app instance (memory): its count carries across requests; the RPC's answer
 * (the total across instances) keeps it right. The meter always writes through the LATEST caller's
 * admin client (never one kept from an earlier request / another user's actor header).
 *
 * One reader at a time (phase 2): takeZohoReader / releaseZohoReader / asZohoReader — a lease on the
 * company's day row (zoho_reader_take / zoho_reader_release, service_role only). It is a courtesy
 * lock on top of the day budget (the hard stop): when the lease RPC itself fails (DB hiccup, the
 * migration not there yet) the read is NOT blocked — logged, and the budget still bounds it.
 */
import type { createAdminClientFor } from "@/lib/supabase/server";
import { createDayMeter, istDayOf, zohoDayBudget, type DayBudgetState, type DayCallsRow, type DayCallsSink, type DayMeter } from "./zoho-day-budget";
import { nextIstMidnight } from "./zoho-limit";

type Db = ReturnType<typeof createAdminClientFor>;
type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;

/** The DB's `date` → YYYY-MM-DD (PostgREST sends it as a string already). */
const dayText = (v: unknown): string => String(v ?? "").slice(0, 10);

export function supabaseDayCallsSink(dbOf: Db | (() => Db), tenantId: string): DayCallsSink {
  const client = (): Db => (typeof dbOf === "function" ? dbOf() : dbOf);
  return {
    async read(day) {
      /* The table is newer than the generated database types: asked for by name (as the RPCs below). */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await ((client() as any).from("zoho_api_day_calls").select("day, calls, limit_hit_at").eq("tenant_id", tenantId).eq("day", day).limit(1) as Res<Array<Record<string, unknown>>>);
      if (r.error) throw new Error(r.error.message ?? "Could not read the Zoho day count.");
      const row = r.data?.[0];
      if (!row) return null;
      return { day: dayText(row.day), calls: Number(row.calls ?? 0), limitHitAt: (row.limit_hit_at as string | null) ?? null } satisfies DayCallsRow;
    },
    async add(day, calls, refusal) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await ((client() as any).rpc("zoho_day_calls_add", { p_tenant: tenantId, p_day: day, p_calls: calls, p_limit_hit: refusal !== null, p_refusal: refusal }) as Res<Array<{ total: number; hit_at: string | null }> | { total: number; hit_at: string | null }>);
      if (r.error) throw new Error(r.error.message ?? "Could not count the Zoho call.");
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!row) throw new Error("Could not count the Zoho call.");
      return { day, calls: Number(row.total ?? 0), limitHitAt: row.hit_at ?? null };
    },
  };
}

const meters = new Map<string, { meter: DayMeter; db: Db }>();

/** This tenant's meter on this app instance (made once; it reads / writes through the latest caller's admin client). */
export function tenantDayMeter(db: Db, tenantId: string): DayMeter {
  let m = meters.get(tenantId);
  if (!m) {
    const made = { db, meter: null as unknown as DayMeter };
    made.meter = createDayMeter(tenantId, supabaseDayCallsSink(() => made.db, tenantId));
    meters.set(tenantId, made);
    m = made;
  }
  m.db = db;
  return m.meter;
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

// ── one Zoho reader at a time per company ──────────────────────────────────────────────────

/** A dialog's read renews the lease with every request; one that was closed frees itself after this. */
export const ZOHO_READER_HOLD_MS = 3 * 60_000;

/**
 * Take (or renew) the company's reader lease as `name` until `untilMs`. null = it is yours; else the
 * name of the read that holds it. Never throws: a failed lease call is logged and does NOT block.
 */
export async function takeZohoReader(db: Db, tenantId: string, name: string, untilMs: number, nowMs: number = Date.now(), log: (m: string) => void = (m) => console.error(m)): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await ((db as any).rpc("zoho_reader_take", { p_tenant: tenantId, p_day: istDayOf(nowMs), p_name: name, p_until: new Date(untilMs).toISOString() }) as Res<string | null>);
    if (r.error) { log(`[zoho-reader] take failed: ${r.error.message ?? "unknown"}`); return null; }
    return typeof r.data === "string" && r.data ? r.data : null;
  } catch (e) {
    log(`[zoho-reader] take failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** Let the lease go (only when it is `name`'s own). Never throws — a lease not released runs out by itself. */
export async function releaseZohoReader(db: Db, tenantId: string, name: string, log: (m: string) => void = (m) => console.error(m)): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await ((db as any).rpc("zoho_reader_release", { p_tenant: tenantId, p_name: name }) as Res<boolean>);
    if (r.error) log(`[zoho-reader] release failed: ${r.error.message ?? "unknown"}`);
  } catch (e) {
    log(`[zoho-reader] release failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Run one request of a Zoho read as the company's only reader. `refused` = another read holds the
 * lease (nothing ran). `run` answers `keep: true` when the read goes on with the next request (the
 * lease stays, renewed then; a closed dialog's lease runs out after ZOHO_READER_HOLD_MS); anything
 * else — done, stopped by the day budget, an error answer, a throw — lets the lease go at once.
 */
export async function asZohoReader<T>(db: Db, tenantId: string, name: string, run: () => Promise<{ value: T; keep: boolean }>): Promise<{ refused: string } | { value: T }> {
  const holder = await takeZohoReader(db, tenantId, name, Date.now() + ZOHO_READER_HOLD_MS);
  if (holder) return { refused: holder };
  let keep = false;
  try {
    const r = await run();
    keep = r.keep;
    return { value: r.value };
  } finally {
    if (!keep) await releaseZohoReader(db, tenantId, name);
  }
}
