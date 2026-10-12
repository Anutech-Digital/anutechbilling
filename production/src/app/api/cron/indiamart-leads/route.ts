/**
 * Cron: IndiaMART Lead Manager pull → leads (S34). Cloud Scheduler "resellersos-indiamart-leads".
 *
 * Every company with a saved IndiaMART CRM key gets its new enquiries as leads, source
 * 'indiamart', de-duplicated on IndiaMART's query id. No key anywhere → `disabled: true` and
 * no network call at all, so scheduling this before anyone has a key is harmless.
 *
 * AUTH FAILS CLOSED, like every cron here: no CRON_SECRET = 503.
 */
import "@/lib/sentry";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { runIndiamartPull } from "@/lib/leads/indiamart.server";
import { gatedCron } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await runIndiamartPull({ admin: createAdminClient() });
  return NextResponse.json(reportCron("indiamart-leads", result));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("indiamart-leads", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
