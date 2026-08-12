/**
 * POST /api/internal/support-sync-nudge
 *
 * Best-effort "check now" nudge for the support_sync_outbox queue (migration
 * 0224). Called fire-and-forget right after record_payment succeeds, so a
 * freshly-created support subscription usually reaches DSP within a second
 * or two instead of waiting for the next scheduled flush. The scheduled
 * flush (/api/cron/support-sync) remains the safety net — this route is
 * purely a latency optimization, not a new source of truth.
 *
 * Auth: any logged-in staff session (not the CRON_SECRET the scheduled route
 * uses) — this is only ever called from the browser, by staff already
 * authenticated into the app.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { flushSupportSyncOutbox } from "@/lib/dsp/support-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await flushSupportSyncOutbox();
  return NextResponse.json(result);
}
