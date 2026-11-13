/**
 * R-2661 — Zoho Books' DAILY API limit, counted per company per IST day, and the stop BEFORE it.
 *
 * 10 Nov 2026 (staging): two Zoho readers (Reconcile from Zoho + the FY purchase read) spent Zoho's
 * daily limit by 04:24Z; zoho-pace.ts only paces the minute, nothing counted the day, and the owner
 * learnt it from 429s. Now:
 *   - every Zoho Books call goes through api.ts booksGet; the access token store.ts hands out is
 *     registered to its tenant's METER here, so every route and the cron count without changes;
 *   - the meter is checked BEFORE each call: budget used today (ZOHO_DAY_BUDGET, default 900 of
 *     Zoho's ~1,000 a day) or Zoho itself said "per day" today → the call is refused with code
 *     `day_limit` and NOT made, so a read's cursor never moves past what was saved;
 *   - each call made adds one to the day row (atomic SQL increment through the sink — the RPC's
 *     answer is the total across every app instance); a write that fails is logged, never thrown,
 *     and the memory count still goes up (conservative);
 *   - the day is India's calendar day (Zoho counts an India organization per day; its own reset time
 *     is not read): the next IST midnight is when a stopped read carries on.
 * Pure: the sink (Supabase in day-calls-store.ts, memory in tests) is given to the meter.
 */
import { toIstDate } from "@/lib/dates/ist";
import { nextIstMidnight } from "./zoho-limit";

/** Zoho's documented daily limit for a Books organization is about 1,000 calls on the plans we know. */
export const ZOHO_DAY_LIMIT_APPROX = 1000;
export const ZOHO_DAY_BUDGET_DEFAULT = 900;

/** The budget (calls a day per company), from ZOHO_DAY_BUDGET when it is a whole number ≥ 1; else the default. */
export function zohoDayBudget(env: string | undefined = process.env.ZOHO_DAY_BUDGET): number {
  const n = Number((env ?? "").trim());
  return Number.isInteger(n) && n >= 1 ? n : ZOHO_DAY_BUDGET_DEFAULT;
}

/** The IST calendar day (YYYY-MM-DD) a call at `ms` counts on. */
export function istDayOf(ms: number): string {
  return toIstDate(ms);
}

/** Zoho's 429 that names the DAY (not the minute): the organization's daily limit is spent. */
export function isZohoDayLimitRefusal(status: number | undefined, message: string | null | undefined): boolean {
  if (status !== 429) return false;
  return /\b(day|daily|today|24 ?hours)\b/i.test(message ?? "");
}

export interface DayCallsRow { day: string; calls: number; limitHitAt: string | null }

/** Where the day rows live (Supabase: day-calls-store.ts; memory: tests). Already bound to ONE tenant. */
export interface DayCallsSink {
  read(day: string): Promise<DayCallsRow | null>;
  /** Add `calls` to the day (atomic); `refusal` = Zoho's own per-day refusal text (marks the day). Returns the new row. */
  add(day: string, calls: number, refusal: string | null): Promise<DayCallsRow>;
}

export interface DayBudgetState {
  day: string;
  calls: number;
  budget: number;
  /** Zoho itself refused for the day (ISO), or null. */
  limitHitAt: string | null;
  /** Budget used or Zoho refused: no more calls today. */
  spent: boolean;
  /** When reading may go on (ms): the next midnight IST. */
  retryAt: number;
}

export interface DayMeter {
  readonly tenantId: string;
  /** Today's state (reads the sink on the first use of a day; after that the RPC answers keep it current). */
  state(nowMs: number): Promise<DayBudgetState>;
  /** null = a call may be made now; else why not. */
  check(nowMs: number): Promise<DayBudgetState | null>;
  /** One call was made. `refused` = Zoho's message when it answered 429 (null otherwise). */
  note(nowMs: number, refused: { status: number; message: string } | null): Promise<void>;
  /** Calls still allowed today (0 when spent). */
  remaining(nowMs: number): Promise<number>;
}

export function createDayMeter(tenantId: string, sink: DayCallsSink, opts: { budget?: number; log?: (m: string) => void } = {}): DayMeter {
  const budget = Math.max(1, Math.floor(opts.budget ?? zohoDayBudget()));
  const log = opts.log ?? ((m: string) => console.error(m));
  let cache: DayCallsRow | null = null;
  const toState = (row: DayCallsRow, nowMs: number): DayBudgetState => ({
    day: row.day, calls: row.calls, budget, limitHitAt: row.limitHitAt,
    spent: row.limitHitAt !== null || row.calls >= budget, retryAt: nextIstMidnight(nowMs),
  });
  const today = async (nowMs: number): Promise<DayCallsRow> => {
    const day = istDayOf(nowMs);
    if (cache && cache.day === day) return cache;
    let row: DayCallsRow | null = null;
    try { row = await sink.read(day); } catch (e) { log(`[zoho-day-budget] read failed: ${(e as Error)?.message ?? e}`); }
    cache = row && row.day === day ? row : { day, calls: 0, limitHitAt: null };
    return cache;
  };
  const state = async (nowMs: number): Promise<DayBudgetState> => toState(await today(nowMs), nowMs);
  return {
    tenantId,
    state,
    async check(nowMs) { const s = await state(nowMs); return s.spent ? s : null; },
    async remaining(nowMs) { const s = await state(nowMs); return s.spent ? 0 : Math.max(0, s.budget - s.calls); },
    async note(nowMs, refused) {
      const row = await today(nowMs);
      const refusal = refused && isZohoDayLimitRefusal(refused.status, refused.message) ? refused.message.slice(0, 300) : null;
      /* Memory first: a failed write still counts (conservative, never under). */
      cache = { day: row.day, calls: row.calls + 1, limitHitAt: row.limitHitAt ?? (refusal ? new Date(nowMs).toISOString() : null) };
      try {
        const fresh = await sink.add(row.day, 1, refusal);
        if (fresh && fresh.day === row.day && cache.day === row.day) {
          cache = { day: fresh.day, calls: Math.max(fresh.calls, cache.calls), limitHitAt: fresh.limitHitAt ?? cache.limitHitAt };
        }
      } catch (e) {
        log(`[zoho-day-budget] count failed: ${(e as Error)?.message ?? e}`);
      }
    },
  };
}

// ── token → meter registry (api.ts booksGet looks the token up; store.ts registers it) ──────

const MAX_TOKENS = 500;
const byToken = new Map<string, DayMeter>();

/** store.ts: this access token belongs to this tenant's meter. Bounded; the oldest entries go first. */
export function registerDayMeter(token: string, meter: DayMeter): void {
  if (!token) return;
  byToken.delete(token);
  byToken.set(token, meter);
  while (byToken.size > MAX_TOKENS) {
    const oldest = byToken.keys().next().value;
    if (oldest === undefined) break;
    byToken.delete(oldest);
  }
}

/** The meter of the tenant this token was handed to, or null (a token not from store.ts: no count, no check). */
export function dayMeterOf(token: string): DayMeter | null {
  return byToken.get(token) ?? null;
}

/** Tests: forget every registration. */
export function forgetDayMeters(): void {
  byToken.clear();
}

// ── words ─────────────────────────────────────────────────────────────────────────────────

/** "Zoho calls today: 612 of 900" */
export function zohoDayCallsLabel(s: Pick<DayBudgetState, "calls" | "budget">): string {
  return `Zoho calls today: ${s.calls.toLocaleString("en-IN")} of ${s.budget.toLocaleString("en-IN")}`;
}
