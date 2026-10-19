/**
 * Cron: Cold Calling (R-1662) — every 10 minutes on weekdays (Cloud Scheduler "resellersos-cold-calls").
 *
 * For every running campaign of every tenant: read finished calls back from Bolna, then place
 * the next calls inside the campaign's window and daily limit. Each tenant through
 * withJobsTenant (app_jobs, RLS), so one tenant's list never sees another's.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { gatedCron } from "@/lib/automation/cron-gate";
import { resolveTelecallProvider } from "@/lib/telecall/provider";
import { listTenantsForJobs, withJobsTenant } from "@/server/db/jobs";
import { runCampaignTick, type Run } from "@/server/coldcall/coldcall.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const config = resolveTelecallProvider();
  if (!config || config.name !== "bolna") {
    return NextResponse.json(reportCron("cold-calls", { ok: true, skipped: "bolna is not configured" }));
  }

  const now = new Date();
  let campaigns = 0, placed = 0, finished = 0, failed = 0;
  const errors: string[] = [];
  for (const tenantId of await listTenantsForJobs()) {
    const run: Run = (fn) => withJobsTenant(tenantId, fn);
    const running = await run((tx) => tx.cold_call_campaigns.findMany({
      where: { status: { in: ["running"] } }, select: { id: true },
    }));
    /* A campaign that was paused with calls still ringing gets its results read too. */
    const paused = await run((tx) => tx.cold_call_contacts.findMany({
      where: { status: "calling" }, select: { campaign_id: true }, distinct: ["campaign_id"],
    }));
    const ids = [...new Set([...running.map((c) => c.id), ...paused.map((c) => c.campaign_id)])];
    for (const id of ids) {
      campaigns++;
      try {
        const r = await runCampaignTick(run, tenantId, id, config, now);
        placed += r.placed; finished += r.finished; failed += r.failed;
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  }
  return NextResponse.json(reportCron("cold-calls", { ok: errors.length === 0, campaigns, placed, finished, failed: failed + errors.length, errors }));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("cold-calls", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
