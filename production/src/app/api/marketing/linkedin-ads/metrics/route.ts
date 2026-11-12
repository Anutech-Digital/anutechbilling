import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { dbFail, withRoute } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";

export const GET = withRoute({ route: "api/marketing/linkedin-ads/metrics" }, async ({ tenantId, user }) => {
  const { data, error } = await createAdminClientFor(user.id).from("linkedin_ad_metrics" as never)
    .select("day, campaign_name, spend, impressions, clicks, leads")
    .eq("tenant_id", tenantId).order("day", { ascending: false }).limit(200);
  dbFail(error, "LinkedIn Ads metrics could not be loaded.");
  return { rows: data ?? [] };
});

const input = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  campaignName: z.string().trim().min(1).max(160),
  spend: z.coerce.number().min(0), impressions: z.coerce.number().int().min(0),
  clicks: z.coerce.number().int().min(0), leads: z.coerce.number().int().min(0),
});

export const POST = withRoute({ route: "api/marketing/linkedin-ads/metrics", input, roles: ["owner", "manager"] }, async ({ input: row, tenantId, user }) => {
  const { error } = await (createAdminClientFor(user.id) as any).from("linkedin_ad_metrics").upsert({
    tenant_id: tenantId, day: row.day, campaign_name: row.campaignName, spend: row.spend,
    impressions: row.impressions, clicks: row.clicks, leads: row.leads, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,day,campaign_name" });
  dbFail(error, "LinkedIn Ads metrics could not be saved.");
  return {};
});
