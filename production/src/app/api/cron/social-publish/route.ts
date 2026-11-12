/**
 * R-2510 (G-SOCIAL): every 10 minutes, publish the APPROVED Facebook / Instagram posts whose post
 * time has come. A draft or a post in review is never touched — a person approves every post.
 * Rule and order: lib/marketing/social-publish-run.ts.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { publishWithPage } from "@/lib/marketing/social-content";
import { runScheduledPublish, type DueRow } from "@/lib/marketing/social-publish-run";
import { gatedCron, cronTenantAllowed, currentCronRun } from "@/lib/automation/cron-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const run = gatedCron("social-publish", handle);
export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function handle(_req: Request) {
  const typed = createAdminClient();
  // social_content is not in the generated Database types yet (same untyped pattern as support-sync).
  const admin = typed as unknown as SupabaseClient;
  try {
    const result = await runScheduledPublish({
      async listDue(now, limit, tenants) {
        /* R-2692: only posts an owner / manager approved (reviewed_by — stamped by the
           social_content approval trigger), and only companies this pass may work on. */
        const due = async (chunk?: string[]) => {
          let query = admin.from("social_content")
            .select("id, tenant_id, platform, format, caption, media_url, status, scheduled_at, reviewed_by")
            .eq("status", "approved").not("reviewed_by", "is", null)
            .not("scheduled_at", "is", null).lte("scheduled_at", now.toISOString());
          if (chunk) query = query.in("tenant_id", chunk);
          const { data, error } = await query.order("scheduled_at", { ascending: true }).limit(limit);
          if (error) throw error;
          return (data ?? []) as DueRow[];
        };
        if (!tenants) return due();
        /* Ids go in the URL — at most 100 per request, then the oldest `limit` overall. */
        const rows: DueRow[] = [];
        for (let i = 0; i < tenants.length; i += 100) rows.push(...await due(tenants.slice(i, i + 100)));
        return rows.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "")).slice(0, limit);
      },
      async claim(id) {
        const { data, error } = await admin.from("social_content")
          .update({ status: "publishing", updated_at: new Date().toISOString() })
          .eq("id", id).eq("status", "approved").not("reviewed_by", "is", null).select("id");
        if (error) throw error;
        return (data ?? []).length === 1;
      },
      connection: (tenantId) => readFacebookPage(typed, tenantId),
      publish: (row, connection) => publishWithPage(row, connection),
      async complete(id, externalId, error) {
        const { error: dbError } = await admin.from("social_content").update({
          status: error ? "failed" : "published", external_id: externalId, error,
          published_at: error ? null : new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", id).eq("status", "publishing");
        if (dbError) throw dbError;
      },
      tenantAllowed: (tenantId) => cronTenantAllowed(tenantId),
      allowedTenants: () => {
        const pass = currentCronRun();
        return pass && !pass.allTenants ? [...pass.tenants] : undefined;
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[social-publish] run failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Scheduled social publishing failed." }, { status: 503 });
  }
}
