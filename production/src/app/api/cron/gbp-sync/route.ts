/**
 * Cron: Google Business Profile sync for every tenant with a connected listing.
 * Nightly (Cloud Scheduler "resellersos-gbp-sync"). Fail-closed auth like the other crons;
 * per-tenant errors are recorded and never abort the run.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { syncTenantGbp } from "@/lib/google/gbp-api";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  // One sync per tenant, with the user who connected it.
  const { data: locs, error } = await admin.from("gbp_locations").select("tenant_id, connected_user_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const tenants = new Map<string, string>();
  for (const l of locs ?? []) if (!tenants.has(l.tenant_id)) tenants.set(l.tenant_id, l.connected_user_id);

  let ok = 0, failed = 0;
  const errors: string[] = [];
  const totals = { locations: 0, reviews: 0, metricRows: 0 };
  for (const [tenantId, userId] of tenants) {
    /* R-897 */ if (!cronTenantAllowed(tenantId)) continue;
    try {
      const r = await syncTenantGbp(admin, userId, tenantId, "cron");
      totals.locations += r.locations; totals.reviews += r.reviews; totals.metricRows += r.metricRows;
      if (r.errors.length) { failed++; errors.push(...r.errors); } else ok++;
    } catch (e) {
      failed++;
      errors.push(`${tenantId}: ${(e as Error).message}`);
    }
  }
  return NextResponse.json(reportCron("gbp-sync", { ok: true, tenants: tenants.size, synced: ok, failed, errors, totals }));
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("gbp-sync", handle);
export async function GET(req: NextRequest) { return gated(req); }
export async function POST(req: NextRequest) { return gated(req); }
