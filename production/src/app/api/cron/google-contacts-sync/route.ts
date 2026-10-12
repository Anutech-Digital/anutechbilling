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
import { reportCron } from "@/lib/ops/cron-report";
import { CONTACT_IMPORT_RETIRED, contactImportRetired } from "@/lib/contacts/retired";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest) {
  /* RETIRED 10 Sep 2026 — see lib/contacts/retired.ts. `contacts` is now only a
     customer's people; anybody who is not a customer yet is a LEAD. Fails closed, so
     no new address-book row can be written whatever still calls this. */
  if (CONTACT_IMPORT_RETIRED) return contactImportRetired();

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
  const errors: string[] = [];
  const totals = { pulled: 0, pushed: 0, created: 0, deleted: 0 };
  for (const r of rows ?? []) {
    /* R-897 */ if (!cronTenantAllowed(r.tenant_id)) continue;
    try {
      const res = await syncUserContacts(admin, r.user_id, r.tenant_id);
      totals.pulled += res.pulled;
      totals.pushed += res.pushed;
      totals.created += res.created;
      totals.deleted += res.deleted;
      ok++;
    } catch (e) {
      failed++;
      /* Wajah do jagah jaati hai. DB wala `last_error` UI ke liye hai; `errors` isliye
         ki reportCron use stderr par likh sake — 13 din tak ye wajah sirf column me thi
         aur usme koi nahi dekh raha tha. */
      const why = (e as Error).message;
      errors.push(why);
      await admin.from("user_google_tokens").update({ last_error: why }).eq("user_id", r.user_id);
    }
  }

  return NextResponse.json(reportCron("google-contacts-sync", {
    ok: true, users: (rows ?? []).length, synced: ok, failed, errors, totals,
  }));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("google-contacts-sync", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
