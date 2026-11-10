/**
 * R-2652 — say plainly when Zoho's limit is hit, instead of retrying silently forever.
 *
 * Staging, 10 Nov 2026: Zoho refused every read (HTTP 429 / daily API limit). The FY "Read from
 * Zoho" dialogs (Expenses → FY from Zoho, Invoices → FY sales from Zoho) showed only "bills: 0 of 0"
 * and the bank "Reconcile from Zoho" sheet "waiting 65s" — each retried every minute with no end,
 * so the owner could not tell that Zoho's limit was reached.
 *
 * Rule: a busy answer is retried after a minute (Zoho's per-minute limit clears by then). After
 * ZOHO_LIMIT_STREAK busy answers IN A ROW (a minute apart, so the per-minute limit cannot be the
 * cause) the loop stops and the dialog says Zoho's daily limit is reached, when to try again (the
 * next midnight IST — Zoho counts an India organization's calls per calendar day) and that nothing
 * was changed. A good answer in between starts the count again. Pure, except `readUntilDone`, which
 * takes its clock and sleep from the caller (tests never wait and never call Zoho).
 */
import { formatDate } from "@/lib/utils";
import { IST_OFFSET_MS, istToday } from "@/lib/dates/ist";

/** Busy answers in a row before the dialog stops retrying and says Zoho's limit is reached. */
export const ZOHO_LIMIT_STREAK = 3;
/** After one busy answer, wait this long before asking again (Zoho's per-minute window). */
export const ZOHO_BUSY_RETRY_MS = 60_000;

export interface ZohoLimitHit {
  /** When the dialog stopped (ms). */
  at: number;
  /** Earliest sensible time to try again (ms) — the next midnight IST. */
  retryAt: number;
  /** "12:00 am IST on 11 Nov 2026" */
  retryLabel: string;
}

/** The next 00:00 in India after `now` (ms since epoch). */
export function nextIstMidnight(now: number): number {
  const [y, m, d] = istToday(new Date(now)).split("-").map(Number);
  return Date.UTC(y, m - 1, d + 1) - IST_OFFSET_MS;
}

export function zohoLimitHit(now: number): ZohoLimitHit {
  const retryAt = nextIstMidnight(now);
  const day = istToday(new Date(retryAt));
  return { at: now, retryAt, retryLabel: `12:00 am IST on ${formatDate(day)}` };
}

/** The words every dialog shows (one place, so the three dialogs never say it differently). */
export function zohoLimitText(hit: ZohoLimitHit): { title: string; body: string } {
  return {
    title: "Zoho's daily limit is reached",
    body: `Zoho refused ${ZOHO_LIMIT_STREAK} reads in a row, so reading has stopped. Try again after ${hit.retryLabel}. ` +
      "Nothing was changed — what was read so far is kept, and Try again carries on from there.",
  };
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
 * answers and ZOHO_BUSY_RETRY_MS after a busy one; stop after ZOHO_LIMIT_STREAK busy in a row.
 * `onBusy(streak)` is called with 0 after a good answer (clear the "busy" line) and n after the
 * nth busy answer. Errors from `step` are thrown to the caller as before.
 */
export async function readUntilDone<R extends { complete: boolean; busy?: boolean }>(opts: {
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
  for (;;) {
    const r = await opts.step();
    opts.onAnswer?.(r);
    if (r.complete) { opts.onBusy?.(0); return { end: "complete" }; }
    if (opts.shouldStop?.()) return { end: "stopped" };
    const hit = streak.note(Boolean(r.busy), now());
    opts.onBusy?.(streak.count);
    if (hit) return { end: "limit", hit };
    await opts.sleep(r.busy ? ZOHO_BUSY_RETRY_MS : opts.gapMs);
    if (opts.shouldStop?.()) return { end: "stopped" };
  }
}
