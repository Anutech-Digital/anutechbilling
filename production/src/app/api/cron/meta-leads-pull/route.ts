/**
 * R-2521: every 30 minutes, bring new Facebook / Instagram lead-form leads of each company's
 * connected Page into Sales → Leads (looks back 2 days, so a missed run loses nothing; the same
 * lead is never saved twice — deterministic id, see lib/meta-leads/leadgen.server.ts).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { pullPageLeads } from "@/lib/meta-leads/page-pull";
import { importPulledLeads } from "@/lib/meta-leads/leadgen.server";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";
const LOOK_BACK_MS = 2 * 86_400_000;

const run = gatedCron("meta-leads-pull", handle);
export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function handle(_req: Request) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("tenant_secrets").select("tenant_id").not("facebook_page_access_token", "is", null);
  if (error) {
    console.error("[meta-leads-pull] tenant list failed", error.message);
    return NextResponse.json({ error: "Could not list connected Pages." }, { status: 503 });
  }
  const results: { tenant: string; created?: number; error?: string }[] = [];
  for (const { tenant_id: tenantId } of data ?? []) {
    if (!cronTenantAllowed(tenantId)) continue;
    try {
      const connection = await readFacebookPage(admin, tenantId);
      if (!connection.pageId || !connection.pageToken) continue;
      const pulled = await pullPageLeads({ pageId: connection.pageId, pageToken: connection.pageToken, since: new Date(Date.now() - LOOK_BACK_MS), graphVersion: GRAPH_VERSION });
      const saved = await importPulledLeads({ admin, tenantId, pageId: connection.pageId, leads: pulled.leads, graphVersion: GRAPH_VERSION });
      results.push({ tenant: tenantId.slice(0, 8), created: saved.created, ...(pulled.error ? { error: pulled.error } : {}) });
    } catch (e) {
      results.push({ tenant: tenantId.slice(0, 8), error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    }
  }
  return NextResponse.json({ tenants: results.length, results });
}
