/**
 * Support-plan sync flush — drains support_sync_outbox to DSP.
 *
 * Schedule: same cadence as /api/cron/renewals once deployed. Local dev can
 * trigger by hitting `curl http://localhost:3000/api/cron/support-sync` with
 * Authorization: Bearer <CRON_SECRET>.
 *
 * Auth: same fail-closed pattern as /api/cron/renewals — without CRON_SECRET
 * set, the route refuses rather than running open.
 */
import { NextResponse } from "next/server";
import { flushSupportSyncOutbox } from "@/lib/dsp/support-sync";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await flushSupportSyncOutbox();
  return NextResponse.json(result);
}
