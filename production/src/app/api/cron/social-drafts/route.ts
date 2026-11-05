import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withTenant } from "@/server/db";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { createSocial, instagramForPage } from "@/lib/marketing/social-content";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import { localDateISO } from "@/lib/leads/outcomes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const run = gatedCron("social-drafts", handle);
export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function handle(_req: Request) {
  const admin = createAdminClient();
  const { data: tenants, error } = await admin.from("tenants").select("id").limit(200);
  if (error) return NextResponse.json({ error: "Could not list companies." }, { status: 503 });
  const today = localDateISO(new Date());
  let created = 0, skipped = 0, failed = 0;
  for (const tenant of tenants ?? []) {
    if (!cronTenantAllowed(tenant.id)) continue;
    try {
      const { data: owner } = await admin.from("users").select("id").eq("tenant_id", tenant.id).eq("role", "owner").eq("is_active", true).limit(1).maybeSingle();
      if (!owner) { skipped++; continue; }
      const session = { tenantId: tenant.id, userId: owner.id, aal: "aal2" as const };
      const settings = await withTenant(session, tx => tx.$queryRaw<{ auto_drafts: boolean; brief: string; last_generated_on: Date | null }[]>`
        select auto_drafts, brief, last_generated_on from public.social_content_settings where tenant_id = ${tenant.id}::uuid`);
      const setting = settings[0];
      if (!setting?.auto_drafts || !setting.brief || (setting.last_generated_on && setting.last_generated_on.toISOString().slice(0,10) === today)) { skipped++; continue; }
      const connection = await readFacebookPage(admin, tenant.id);
      if (!connection.pageId || !connection.pageToken) { skipped++; continue; }
      const ai = await resolveGeminiConfig(admin, tenant.id);
      if (!ai.apiKey) { skipped++; continue; }
      const instagram = await instagramForPage(connection.pageId, connection.pageToken);
      const platforms = instagram ? (["facebook", "instagram"] as const) : (["facebook"] as const);
      let made = 0;
      for (const platform of platforms) {
        const result = await geminiJson<{ caption?: string }>({ apiKey: ai.apiKey, model: ai.model, tenantId: tenant.id,
          label: "marketing/social-scheduled-draft", temperature: 0.5,
          system: "Draft one concise, useful B2B cloud reseller social post as JSON with a caption field. No invented facts, prices, testimonials, or urgency. At most 3 hashtags. The draft will be reviewed by a human.",
          user: `Platform: ${platform}. Business guidance: ${setting.brief}` });
        const caption = result?.caption?.trim().slice(0, 2200);
        if (!caption) { failed++; continue; }
        await createSocial(session, { platform, format: "post", caption, mediaUrl: null, topic: setting.brief.slice(0, 500), origin: "scheduled" });
        created++; made++;
      }
      if (made > 0) await withTenant(session, tx => tx.$executeRaw`
        update public.social_content_settings set last_generated_on = ${today}::date where tenant_id = ${tenant.id}::uuid`);
    } catch (e) {
      console.error("[social-drafts] company failed", tenant.id, e instanceof Error ? e.message : "unknown"); failed++;
    }
  }
  return NextResponse.json({ created, skipped, failed });
}
