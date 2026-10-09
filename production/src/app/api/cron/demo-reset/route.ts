/**
 * GET|POST /api/cron/demo-reset — nightly reset of the "Try the demo" workspace (R-524).
 *
 *  1. Makes the demo workspace + its two logins if they do not exist yet (first run).
 *  2. Signs in as the SEEDER login (never the visitor) on a session-less client.
 *  3. Clears every "DEMO · " row of the demo workspace and adds a fresh set dated today, so
 *     renewals / overdue invoices always look current.
 *
 * Idempotent: running it twice gives the same workspace. Every sample-row write goes through
 * the seeder's own login, so RLS keeps it inside the demo tenant — no other tenant can be
 * touched even by a bug here. Visitors cannot have written anything (read-only), so there is
 * nothing else to clean.
 *
 * Does nothing while DEMO_ENABLED is off. AUTH FAILS CLOSED, like every other cron here.
 * Schedule (manager): Cloud Scheduler, daily 02:30 IST, Authorization: Bearer $CRON_SECRET.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient as createSessionlessClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { istToday } from "@/lib/dates/ist";
import { DEMO_SEEDER_EMAIL, demoEnabled } from "@/lib/demo/demo-account";
import { ensureDemoTenant, resetDemoData, signInAs } from "@/lib/demo/demo-account.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!demoEnabled()) return NextResponse.json({ ok: true, skipped: "DEMO_ENABLED is off" });

  const admin = createAdminClient() as unknown as SupabaseClient;
  const ensured = await ensureDemoTenant(admin);
  if (!ensured.ok) return NextResponse.json(reportCron("demo-reset", { ok: false, error: ensured.error }), { status: 500 });

  const seeder = createSessionlessClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signed = await signInAs(admin, seeder, DEMO_SEEDER_EMAIL);
  if (!signed.ok || signed.userId !== ensured.demo.seeder_user_id) {
    const error = signed.ok ? "Seeder login does not match demo_tenants." : signed.error;
    return NextResponse.json(reportCron("demo-reset", { ok: false, error }), { status: 500 });
  }

  const r = await resetDemoData(seeder, ensured.demo, { today: istToday(), stamp: Date.now(), newId: randomUUID });
  await seeder.auth.signOut({ scope: "local" });
  const body = r.ok
    ? { ok: true, created: ensured.created, cleared: r.cleared, added: r.added, invoicesSkipped: r.invoicesSkipped }
    : { ok: false, error: r.error };
  return NextResponse.json(reportCron("demo-reset", body), { status: r.ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
