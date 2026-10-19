/**
 * R-1587 (18 Oct 2026): how the four provisioning crons (register-domains, renew-domains,
 * provision-hosting, renew-hosting) answer, so a DMS outage is HEARD.
 *
 * Until then each returned a bare 200 `{ran, ...summary}`: with the DMS engine down every row
 * was counted `skipped`, Cloud Scheduler showed green, no `[cron/<job>]` stderr line reached
 * the health digest and no heartbeat was pinged — for orders the customer had already paid.
 *
 * Now, like every other cron (lib/ops/cron-report.ts):
 *   · the body carries `failed` (the registrar/DirectAdmin refusals) and `errors` (one line
 *     per row that could not reach DMS, needs reconciling or was refused), and goes through
 *     reportCron → a `[cron/<job>]` stderr line + heartbeat `/fail` when either is non-empty;
 *   · when EVERY engine call of the run failed to reach DMS the answer is 503 + Retry-After,
 *     so the Scheduler retries and the run is stamped "Failed (503)" on the Automation page.
 *     A partial outage stays 200 (the rows that worked must not be re-run for it) but is
 *     still reported.
 *   · a failed queue read → cronDbFailure (503 / 500 + the same stderr line).
 */
import { NextResponse } from "next/server";
import { reportCron } from "@/lib/ops/cron-report";

export type ProvisioningJob = "register-domains" | "renew-domains" | "provision-hosting" | "renew-hosting";

/** What a run saw of the DMS engine, besides the route's own counts. */
export interface EngineHealth {
  /** Engine calls made (commands sent + DMS service reads). */
  calls: number;
  /** Of those, how many could not reach DMS (or got no usable answer). */
  down: number;
  /** One readable line per problem row. */
  errors: string[];
}

export const newEngineHealth = (): EngineHealth => ({ calls: 0, down: 0, errors: [] });

/** An engine call answered (whatever the answer). */
export function engineAnswered(h: EngineHealth): void {
  h.calls += 1;
}

/** An engine call that never got a usable answer from DMS. */
export function engineDown(h: EngineHealth, line: string): void {
  h.calls += 1;
  h.down += 1;
  h.errors.push(line);
}

/** The cron's response: reported (stderr + heartbeat), 503 when DMS was down for the whole run. */
export function provisioningResponse(
  job: ProvisioningJob,
  summary: { refused: number } & Record<string, number>,
  health: EngineHealth,
  extra: Record<string, string> = {},
): NextResponse {
  const body = reportCron(job, { ran: true, ...summary, ...extra, failed: summary.refused, errors: health.errors });
  const allDown = health.calls > 0 && health.down === health.calls;
  return allDown
    ? NextResponse.json({ ...body, dmsUnreachable: true }, { status: 503, headers: { "Retry-After": "300" } })
    : NextResponse.json(body);
}
