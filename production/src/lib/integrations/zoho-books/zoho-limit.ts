/**
 * R-2652 — say plainly when Zoho's limit is hit, instead of retrying silently forever.
 *
 * Staging, 10 Nov 2026: Zoho refused every read (HTTP 429 / daily API limit). The FY "Read from
 * Zoho" dialogs (Expenses → FY from Zoho, Invoices → FY sales from Zoho) showed only "bills: 0 of 0"
 * and the bank "Reconcile from Zoho" sheet "waiting 65s" — each retried every minute with no end,
 * so the owner could not tell that Zoho's limit was reached.
 *
 * Rule: a busy answer is retried after a minute (Zoho's per-minute limit clears by then). After
 * ZOHO_LIMIT_STREAK busy answers IN A ROW that read NOTHING (a minute apart, so the per-minute limit
 * cannot be the cause) the loop stops and the dialog says Zoho's daily limit is reached, when to try
 * again (the next midnight IST — assumed: Zoho counts an India organization's calls per calendar
 * day; Zoho's own reset time is not read yet) and that nothing was changed. An answer that read
 * something (busy part-way, e.g. another reader shares the minute) starts the count again. Pure,
 * except `readUntilDone`, which takes its clock and sleep from the caller (tests never wait and
 * never call Zoho). Used by the FY sales / FY purchases dialogs and the bank Reconcile from Zoho
 * sheet; the FY receipts dialog reads in the background (cron) and is not covered here.
 */
import { formatDate } from "@/lib/utils";
import { IST_OFFSET_MS, istToday } from "@/lib/dates/ist";
import { ZOHO_BUSY_WAIT_MS } from "./zoho-pace";

/** Busy answers in a row before the dialog stops retrying and says Zoho's limit is reached. */
export const ZOHO_LIMIT_STREAK = 3;
/** After one busy answer, wait this long before asking again (the same wait as the bank sheet). */
export const ZOHO_BUSY_RETRY_MS = ZOHO_BUSY_WAIT_MS;

export interface ZohoLimitHit {
  /** When the dialog stopped (ms). */
  at: number;
  /** Earliest sensible time to try again (ms) — the next midnight IST. */
  retryAt: number;
  /** "12:00 am IST on 11 Nov 2026" */
  retryLabel: string;
  /** R-2661: why — Zoho refused ZOHO_LIMIT_STREAK reads in a row (default), or the app's own day budget
   *  is used ("budget": the server refused before calling Zoho; `calls` of `budget` made today). */
  reason?: "refused" | "budget";
  calls?: number;
  budget?: number;
}

/** R-2661: what a read route answers when the day's budget is used (the dialog stops at once). */
export interface DayLimitAnswer { calls: number; budget: number; retryAt: number; day?: string }

/** The next 00:00 in India after `now` (ms since epoch). */
export function nextIstMidnight(now: number): number {
  const [y, m, d] = istToday(new Date(now)).split("-").map(Number);
  return Date.UTC(y, m - 1, d + 1) - IST_OFFSET_MS;
}

export function zohoLimitHit(now: number, budget?: DayLimitAnswer): ZohoLimitHit {
  const retryAt = budget?.retryAt && Number.isFinite(budget.retryAt) ? budget.retryAt : nextIstMidnight(now);
  const day = istToday(new Date(retryAt));
  const hit: ZohoLimitHit = { at: now, retryAt, retryLabel: `12:00 am IST on ${formatDate(day)}` };
  if (budget) { hit.reason = "budget"; hit.calls = budget.calls; hit.budget = budget.budget; }
  return hit;
}

/** The words every dialog shows (one place, so the three dialogs never say it differently). */
export function zohoLimitText(hit: ZohoLimitHit): { title: string; body: string } {
  if (hit.reason === "budget") {
    /* R-2661: the app stopped BEFORE Zoho's limit — the per-day budget (zoho-day-budget.ts) is used. */
    const n = (x: number | undefined) => (x ?? 0).toLocaleString("en-IN");
    return {
      title: "Zoho's daily limit is reached",
      body: `Zoho calls today: ${n(hit.calls)} of ${n(hit.budget)} — the day's budget is used, so reading has stopped before Zoho refuses. ` +
        `It carries on after ${hit.retryLabel}. Nothing was changed — what was read so far is kept, and Try again carries on from there.`,
    };
  }
  return {
    title: "Zoho's daily limit is reached",
    body: `Zoho refused ${ZOHO_LIMIT_STREAK} reads in a row, so reading has stopped. Try again after ${hit.retryLabel}. ` +
      "Nothing was changed — what was read so far is kept, and Try again carries on from there.",
  };
}

/** R-2661: the server's own words for a read stopped by the day budget (bg_error, route messages). */
export function zohoDayLimitMessage(d: DayLimitAnswer, now: number = Date.now()): string {
  return zohoLimitText(zohoLimitHit(now, d)).body;
}

/** While retrying: "Zoho is busy — trying again in a minute (2 of 3)." */
export function zohoBusyText(streak: number): string {
  return `Zoho is busy — trying again in a minute (${Math.min(streak, ZOHO_LIMIT_STREAK)} of ${ZOHO_LIMIT_STREAK}).`;
}

/** Counts busy answers in a row. `note(true)` returns a hit once the streak reaches the limit. */
export function busyStreak(limit = ZOHO_LIMIT_STREAK) {
  let count = 0;
  return {
    get count() { return count; },
    note(busy: boolean, now: number): ZohoLimitHit | null {
      count = busy ? count + 1 : 0;
      return count >= limit ? zohoLimitHit(now) : null;
    },
    reset() { count = 0; },
  };
}

export type ReadLoopEnd =
  | { end: "complete" }
  | { end: "stopped" }
  | { end: "limit"; hit: ZohoLimitHit };

/**
 * The FY dialogs' read loop: call `step` until the read is complete; wait `gapMs` between good
 * answers and ZOHO_BUSY_RETRY_MS after a busy one; stop after ZOHO_LIMIT_STREAK busy answers in
 * a row that read nothing (`listed` / `detailed` did not move), or at once on a `dayLimit` answer
 * (R-2661: the app's own day budget is used). `onBusy(streak)` is called with 0
 * after a good answer (clear the "busy" line) and n after the nth such busy answer. Errors from
 * `step` are thrown to the caller as before.
 */
export async function readUntilDone<R extends { complete: boolean; busy?: boolean; listed?: number; detailed?: number; dayLimit?: DayLimitAnswer | null }>(opts: {
  step: () => Promise<R>;
  onAnswer?: (r: R) => void;
  onBusy?: (streak: number) => void;
  shouldStop?: () => boolean;
  gapMs: number;
  sleep: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<ReadLoopEnd> {
  const streak = busyStreak();
  const now = opts.now ?? Date.now;
  let last: string | null = null;
  for (;;) {
    const r = await opts.step();
    opts.onAnswer?.(r);
    if (r.complete) { opts.onBusy?.(0); return { end: "complete" }; }
    /* R-2661: the server refused before calling Zoho — the day's budget is used: stop at once, say so. */
    if (r.dayLimit) { opts.onBusy?.(0); return { end: "limit", hit: zohoLimitHit(now(), r.dayLimit) }; }
    if (opts.shouldStop?.()) return { end: "stopped" };
    /* Busy part-way (something was read) is not the daily limit — the count starts again. */
    const mark = `${r.listed ?? ""}/${r.detailed ?? ""}`;
    const readSomething = last !== null && mark !== last;
    last = mark;
    const hit = streak.note(Boolean(r.busy) && !readSomething, now());
    opts.onBusy?.(streak.count);
    if (hit) return { end: "limit", hit };
    await opts.sleep(r.busy ? ZOHO_BUSY_RETRY_MS : opts.gapMs);
    if (opts.shouldStop?.()) return { end: "stopped" };
  }
}
