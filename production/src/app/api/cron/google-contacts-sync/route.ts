/**
 * Cron: two-way Google Contacts sync for every connected user.
 *
 * Runs the same engine as the "Sync now" button, across all users who have
 * connected Google. Fail-closed auth (CRON_SECRET + timing-safe compare), same
 * pattern as /api/cron/renewals. Per-user errors are recorded (last_error) and
 * never abort the whole run.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { syncUserContacts } from "@/lib/google/contacts";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (!timingSafeEqualStr(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("user_google_tokens")
    .select("user_id, tenant_id, refresh_token")
    .not("refresh_token", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let ok = 0;
  let failed = 0;
  const totals = { pulled: 0, pushed: 0, created: 0, deleted: 0 };
  for (const r of rows ?? []) {
    try {
      const res = await syncUserContacts(admin, r.user_id, r.tenant_id);
      totals.pulled += res.pulled;
      totals.pushed += res.pushed;
      totals.created += res.created;
      totals.deleted += res.deleted;
      ok++;
    } catch (e) {
      failed++;
      await admin.from("user_google_tokens").update({ last_error: (e as Error).message }).eq("user_id", r.user_id);
    }
  }

  return NextResponse.json({ ok: true, users: (rows ?? []).length, synced: ok, failed, totals });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
