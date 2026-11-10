/**
 * R-2521 / R-2522: every 30 minutes, bring new leads of each company's CHOSEN Facebook / Instagram
 * lead forms into Sales → Leads (looks back 2 days, so a missed run loses nothing; the same lead is
 * never saved twice — deterministic id, see lib/meta-leads/leadgen.server.ts).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pullChosenForms, untyped } from "@/lib/meta-leads/lead-forms.server";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LOOK_BACK_MS = 2 * 86_400_000;

const run = gatedCron("meta-leads-pull", handle);
export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function handle(_req: Request) {
  const admin = createAdminClient();
  const { data, error } = await untyped(admin).from("meta_lead_forms").select("tenant_id").eq("enabled", true);
  if (error) {
    console.error("[meta-leads-pull] tenant list failed", error.message);
    return NextResponse.json({ error: "Could not list chosen lead forms." }, { status: 503 });
  }
  const tenants = [...new Set(((data ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id))];
  const results: { tenant: string; created?: number; problems?: string[]; error?: string }[] = [];
  for (const tenantId of tenants) {
    if (!cronTenantAllowed(tenantId)) continue;
    try {
      const sum = await pullChosenForms(admin, tenantId, new Date(Date.now() - LOOK_BACK_MS));
      results.push({ tenant: tenantId.slice(0, 8), created: sum.created, ...(sum.problems.length ? { problems: sum.problems } : {}) });
    } catch (e) {
      results.push({ tenant: tenantId.slice(0, 8), error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    }
  }
  return NextResponse.json({ tenants: results.length, results });
}
