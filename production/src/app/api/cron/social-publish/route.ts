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
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import { logSystemActivity } from "@/lib/marketing/social-activity";

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
      async listDue(now, limit) {
        const { data, error } = await admin.from("social_content")
          .select("id, tenant_id, platform, format, caption, media_url, status, scheduled_at, origin")
          .eq("status", "approved").not("scheduled_at", "is", null).lte("scheduled_at", now.toISOString())
          .order("scheduled_at", { ascending: true }).limit(limit);
        if (error) throw error;
        return (data ?? []) as DueRow[];
      },
      async claim(id) {
        const { data, error } = await admin.from("social_content")
          .update({ status: "publishing", updated_at: new Date().toISOString() })
          .eq("id", id).eq("status", "approved").select("id");
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
      // R-2687: "Stop all AI" holds the AI's posts; a person's posts still go out.
      async aiPaused(tenantId) {
        const { data } = await admin.from("social_content_settings").select("ai_paused").eq("tenant_id", tenantId).maybeSingle();
        return Boolean((data as { ai_paused?: boolean } | null)?.ai_paused);
      },
      log: (row, result, detail) => logSystemActivity(admin, row.tenant_id, { actor: row.origin === "scheduled" ? "ai" : "system", platform: row.platform, action: result === "ok" ? "Posted" : "Post failed", detail: `${detail} — ${row.caption.slice(0, 80)}`, contentId: row.id, result }),
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[social-publish] run failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Scheduled social publishing failed." }, { status: 503 });
  }
}
