/**
 * Help AI call caps (R-2879 / H-01b).
 *
 *   - HELP_QUESTION_CALLS_MAX — tool calls ONE question may make in all, over every round of the
 *     model's loop. Counted on the HelpSession (session.ts), which the route opens once per
 *     question, so a loop cannot reset it by sending a new batch. (HELP_CALLS_MAX in runner.ts is
 *     the cap for one batch.)
 *   - HELP_TOOL_RATE — tool calls one PERSON may make in a window, whatever number of questions
 *     they are spread over. Refused calls count too.
 *
 * The counter is the same design as the app's rate limiter (lib/security/rate-limit.ts: fixed
 * window, in memory, per instance — it bounds cost, it is not perfect fairness). That file cannot
 * be imported here: it also holds the shared-store path that names the service-role key, and no
 * file reachable from a help tool may (help-tools-guard.test.ts). So the same few lines live here.
 */

export const HELP_QUESTION_CALLS_MAX = 20;

/** 120 tool calls in 10 minutes for one person (the route allows 30 questions in that time). */
export const HELP_TOOL_RATE = Object.freeze({ limit: 120, windowMs: 10 * 60_000 });

interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();
/** Memory lock: past this many people, expired counters are dropped, then the oldest half. */
const MAX_KEYS = 10_000;

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  if (buckets.size < MAX_KEYS) return;
  let drop = Math.floor(buckets.size / 2);
  for (const k of buckets.keys()) {
    if (drop-- <= 0) break;
    buckets.delete(k);
  }
}

/** A user id as the session gives it: a non-empty string of sane length. */
export function isHelpUserId(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 100;
}

/** Count one tool call for this person. false = over the limit, the call must not run. */
export function helpToolRateOk(userId: string, now: number = Date.now()): boolean {
  if (!isHelpUserId(userId)) return false;
  prune(now);
  const b = buckets.get(userId);
  if (!b || b.resetAt <= now) {
    buckets.set(userId, { count: 1, resetAt: now + HELP_TOOL_RATE.windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= HELP_TOOL_RATE.limit;
}

/** Tests only (the guard lets no file in src import it). */
export function resetHelpToolRate(): void {
  buckets.clear();
}
