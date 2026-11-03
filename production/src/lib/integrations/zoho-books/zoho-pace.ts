/**
 * R-2402 — keeping the bulk "Reconcile from Zoho" under Zoho Books' limit (about 100 API calls a
 * minute per organization). The server says how many Zoho calls each page cost; the browser waits
 * before the next page so the calls of the last 60 seconds plus the next page's stay within
 * ZOHO_CALLS_PER_MIN. Pure.
 */

/** Our budget: under Zoho's 100 a minute, with room for someone using Find in Zoho at the same time. */
export const ZOHO_CALLS_PER_MIN = 80;
export const PACE_WINDOW_MS = 60_000;
/** After Zoho says "busy", wait this long before the next page. */
export const ZOHO_BUSY_WAIT_MS = 65_000;

export interface PaceEntry { at: number; calls: number }

/** Milliseconds to wait before a page expected to cost `nextCost` calls (0 = go now). */
export function paceWaitMs(history: readonly PaceEntry[], now: number, nextCost: number, budget = ZOHO_CALLS_PER_MIN): number {
  const recent = history.filter((h) => h.calls > 0 && now - h.at < PACE_WINDOW_MS).sort((a, b) => a.at - b.at);
  let used = recent.reduce((s, h) => s + h.calls, 0);
  const cost = Math.min(Math.max(0, nextCost), budget);
  if (used + cost <= budget) return 0;
  /* Wait until enough of the oldest pages leave the window. */
  for (const h of recent) {
    used -= h.calls;
    if (used + cost <= budget) return Math.max(0, h.at + PACE_WINDOW_MS - now);
  }
  return 0;
}

/** What the next page will probably cost: the most a recent page cost (first page: a guess). */
export function expectedPageCost(history: readonly PaceEntry[], firstGuess = 30): number {
  const last = history.slice(-5).map((h) => h.calls);
  return last.length ? Math.max(...last) : firstGuess;
}
