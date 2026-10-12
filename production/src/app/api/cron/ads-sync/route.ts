/**
 * Cron: Google Ads + Meta Ads spend sync for every tenant with an enabled ad account.
 * Nightly (Cloud Scheduler "resellersos-ads-sync"). Fail-closed auth like the other crons.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { syncTenantAds } from "@/lib/marketing/ad-sync";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: rows, error } = await admin.from("ad_accounts").select("tenant_id").eq("enabled", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const tenants = [...new Set((rows ?? []).map((r) => r.tenant_id))];

  let ok = 0, failed = 0;
  const errors: string[] = [];
  const totals = { accounts: 0, rowsWritten: 0 };
  for (const tenantId of tenants) {
    /* R-897 */ if (!cronTenantAllowed(tenantId)) continue;
    try {
      const r = await syncTenantAds(admin, tenantId, "cron");
      totals.accounts += r.accounts; totals.rowsWritten += r.rowsWritten;
      if (r.errors.length) { failed++; errors.push(...r.errors); } else ok++;
    } catch (e) { failed++; errors.push(`${tenantId}: ${(e as Error).message}`); }
  }
  return NextResponse.json(reportCron("ads-sync", { ok: true, tenants: tenants.length, synced: ok, failed, errors, totals }));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("ads-sync", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
