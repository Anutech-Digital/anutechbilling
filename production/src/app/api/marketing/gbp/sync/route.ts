/**
 * POST /api/marketing/gbp/sync — pull listings, reviews and performance from Google now.
 * Uses the token of whoever connected the listing for this tenant (any owner/manager may
 * press the button). The nightly cron does the same for every tenant.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { syncTenantGbp } from "@/lib/google/gbp-api";
import { withRoute, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const POST = withRoute(
  { route: "api/marketing/gbp/sync", roles: ["owner", "manager", "marketing"] },
  async ({ tenantId, user }) => {
    const admin = createAdminClient();
    const { data: loc } = await admin.from("gbp_locations").select("connected_user_id").eq("tenant_id", tenantId).limit(1).maybeSingle();
    const syncUser = loc?.connected_user_id ?? user.id;
    try {
      const result = await syncTenantGbp(admin, syncUser, tenantId, "manual");
      return { ...result, ok: result.errors.length === 0 };
    } catch (e) {
      throw new RouteError(502, (e as Error).message || "Sync failed");
    }
  },
);
