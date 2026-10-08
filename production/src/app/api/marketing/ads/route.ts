/**
 * GET  /api/marketing/ads — what is configured / connected, per platform. No tokens.
 * PATCH /api/marketing/ads — { accountId, enabled } toggle (the only user-side write).
 */
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { hasGoogleAdsScope } from "@/lib/google/scope-union";
import { googleAdsDeveloperToken } from "@/lib/google/google-ads-api";
import { metaAppCreds } from "@/lib/meta/meta-ads-api";
import { withRoute, dbFail } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoute({ route: "api/marketing/ads" }, async ({ tenantId, user }) => {
  const admin = createAdminClientFor(user.id);
  const { data: accounts } = await admin.from("ad_accounts")
    .select("id, platform, account_id, name, currency, enabled, connected_user_id, token_expires_at, last_synced_at, last_error")
    .eq("tenant_id", tenantId).order("platform").order("name");

  const googleUser = (accounts ?? []).find((a) => a.platform === "google-ads")?.connected_user_id ?? user.id;
  const { data: tok } = await admin.from("user_google_tokens").select("google_email, refresh_token, scopes, last_error").eq("user_id", googleUser).maybeSingle();
  const googleConnected = Boolean(tok?.refresh_token) && hasGoogleAdsScope(tok?.scopes);
  const metaRows = (accounts ?? []).filter((a) => a.platform === "meta-ads");
  const metaExpiry = metaRows.map((a) => a.token_expires_at).filter(Boolean).sort()[0] ?? null;

  return {
    google: {
      configured: !!googleOAuthCreds(), devToken: !!googleAdsDeveloperToken(), connected: googleConnected,
      email: googleConnected ? tok?.google_email ?? null : null,
      lastError: tok?.last_error ?? null,
    },
    meta: { configured: !!metaAppCreds(), connected: metaRows.length > 0, tokenExpiresAt: metaExpiry },
    accounts: (accounts ?? []).map((a) => ({ id: a.id, platform: a.platform, account_id: a.account_id, name: a.name, currency: a.currency, enabled: a.enabled, last_synced_at: a.last_synced_at, last_error: a.last_error })),
  };
});

const patchSchema = z.object({
  accountId: z.string({ message: "accountId + enabled chahiye." }).min(1, "accountId + enabled chahiye."),
  enabled: z.boolean({ message: "accountId + enabled chahiye." }),
});

export const PATCH = withRoute(
  { route: "api/marketing/ads", input: patchSchema, roles: ["owner", "manager"] },
  async ({ input, tenantId, user }) => {
    const { error } = await createAdminClientFor(user.id).from("ad_accounts")
      .update({ enabled: input.enabled, updated_at: new Date().toISOString() })
      .eq("id", input.accountId).eq("tenant_id", tenantId);
    dbFail(error, "Ad account update nahi hua — page refresh karke dobara try kariye.");
    return {};
  },
);
