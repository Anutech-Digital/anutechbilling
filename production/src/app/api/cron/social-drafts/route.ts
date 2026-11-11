/**
 * Monday 9:00: the AI plans the week's Facebook / Instagram posts for every company that turned
 * weekly AI posts on (R-2672). Autopilot companies get approved posts that go out at their time;
 * the others get posts waiting for approval. The plan itself: lib/marketing/social-autopilot.server.ts.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { planWeek } from "@/lib/marketing/social-autopilot.server";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;
const run = gatedCron("social-drafts", handle);
export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function handle(_req: Request) {
  const admin = createAdminClient();
  const { data: tenants, error } = await admin.from("tenants").select("id").limit(200);
  if (error) return NextResponse.json({ error: "Could not list companies." }, { status: 503 });
  let created = 0, skipped = 0, failed = 0;
  for (const tenant of tenants ?? []) {
    if (!cronTenantAllowed(tenant.id)) continue;
    try {
      const { data: owner } = await admin.from("users").select("id").eq("tenant_id", tenant.id).eq("role", "owner").eq("is_active", true).limit(1).maybeSingle();
      if (!owner) { skipped++; continue; }
      const session = { tenantId: tenant.id, userId: owner.id, aal: "aal2" as const };
      const result = await planWeek(admin, session);
      if (result.ok) created += result.created; else skipped++;
    } catch (e) {
      console.error("[social-drafts] company failed", tenant.id, e instanceof Error ? e.message : "unknown"); failed++;
    }
  }
  return NextResponse.json({ created, skipped, failed });
}
