/**
 * R-702, R-704, R-706..R-709, R-711: what a cron answers when its first database read fails.
 *
 * 9–10 Oct 2026 every cron on live answered a bare `500 {error: "TypeError: fetch failed"}`
 * for 24 hours — gmail-inbox 1,439 times, then billing, renewals, dunning, backup, trial
 * expiry… one by one as their daily slot came round. Every one was the same thing: the
 * server could not open a connection to the database API (api.anutech.in). Read as twelve
 * separate cron bugs, it became twelve board cards.
 *
 * Now the answer says which of the two it is:
 *   · database unreachable → 503 + `dbUnreachable: true`, and one `[cron/<job>]` stderr line
 *     reading "database unreachable" (reportCron), so the health digest and the live-error
 *     scan group them as ONE outage, not N bugs;
 *   · anything else (a real query fault) → 500 with the same `error` text as before, now
 *     also reported on stderr.
 * Cloud Scheduler retries both.
 */
import { NextResponse } from "next/server";
import { reportCron } from "@/lib/ops/cron-report";
import { isUnreachableError } from "@/lib/supabase/resilient-fetch";

export const DB_UNREACHABLE = "database unreachable (api.anutech.in did not answer)";

/** Body always carries `error: string`, so a route typed `NextResponse<Result | { error: string }>` accepts it. */
export type CronDbFailureBody = { error: string; errors: string[]; ok?: false; dbUnreachable?: true };

/**
 * @param job      cron name, as in reportCron
 * @param e        the thrown error / returned PostgREST error
 * @param message  the route's own error text (kept as the 500 body's `error`)
 */
export function cronDbFailure(job: string, e: unknown, message: string): NextResponse<CronDbFailureBody> {
  if (isUnreachableError(e)) {
    return NextResponse.json<CronDbFailureBody>(
      reportCron(job, { ok: false, dbUnreachable: true, error: DB_UNREACHABLE, errors: [DB_UNREACHABLE] }),
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  return NextResponse.json<CronDbFailureBody>(reportCron(job, { error: message, errors: [message] }), { status: 500 });
}
