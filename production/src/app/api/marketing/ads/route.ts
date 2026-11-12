/**
 * GET  /api/marketing/ads — what is configured / connected, per platform. No tokens.
 * PATCH /api/marketing/ads — pause or resume one account.
 * DELETE /api/marketing/ads — remove a connection, keeping its saved spend history.
 */
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { hasGoogleAdsScope } from "@/lib/google/scope-union";
import { googleAdsDeveloperToken } from "@/lib/google/google-ads-api";
import { metaAppCreds } from "@/lib/meta/meta-ads-api";
import { linkedInCreds } from "@/lib/integrations/linkedin/config";
import { readLinkedInAdsCredentials } from "@/lib/integrations/linkedin/store";
import { withRoute, dbFail, RouteError } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoute({ route: "api/marketing/ads" }, async ({ tenantId, user }) => {
  const admin = createAdminClientFor(user.id);
  const { data: accounts, error: accountsError } = await admin.from("ad_accounts")
    .select("id, platform, account_id, name, currency, enabled, connected_user_id, token_expires_at, last_synced_at, last_error")
    .eq("tenant_id", tenantId).is("archived_at", null).order("platform").order("name");
  dbFail(accountsError, "Ad account status could not be loaded.");

  const googleUser = (accounts ?? []).find((a) => a.platform === "google-ads")?.connected_user_id ?? user.id;
  const { data: tok, error: tokenError } = await admin.from("user_google_tokens").select("google_email, refresh_token, scopes, last_error").eq("user_id", googleUser).maybeSingle();
  dbFail(tokenError, "Google Ads status could not be loaded.");
  const googleConnected = Boolean(tok?.refresh_token) && hasGoogleAdsScope(tok?.scopes);
  const metaRows = (accounts ?? []).filter((a) => a.platform === "meta-ads");
  const metaExpiry = metaRows.map((a) => a.token_expires_at).filter(Boolean).sort()[0] ?? null;
  const linkedInRows = (accounts ?? []).filter((a) => a.platform === "linkedin-ads");
  const linkedInExpiry = linkedInRows.map((a) => a.token_expires_at).filter(Boolean).sort()[0] ?? null;

  return {
    google: {
      configured: !!googleOAuthCreds(), devToken: !!googleAdsDeveloperToken(), connected: googleConnected,
      email: googleConnected ? tok?.google_email ?? null : null,
      lastError: tok?.last_error ?? null,
    },
    meta: { configured: !!metaAppCreds(), connected: metaRows.length > 0, tokenExpiresAt: metaExpiry },
    linkedin: { configured: !!linkedInCreds() || !!await readLinkedInAdsCredentials(admin, tenantId), connected: linkedInRows.length > 0, tokenExpiresAt: linkedInExpiry },
    accounts: (accounts ?? []).map((a) => ({ id: a.id, platform: a.platform, account_id: a.account_id, name: a.name, currency: a.currency, enabled: a.enabled, last_synced_at: a.last_synced_at, last_error: a.last_error })),
  };
});

const patchSchema = z.object({
  accountId: z.string({ message: "accountId and enabled are required." }).min(1, "accountId and enabled are required."),
  enabled: z.boolean({ message: "accountId and enabled are required." }),
});

export const PATCH = withRoute(
  { route: "api/marketing/ads", input: patchSchema, roles: ["owner", "manager"] },
  async ({ input, tenantId, user }) => {
    const { error } = await createAdminClientFor(user.id).from("ad_accounts")
      .update({ enabled: input.enabled, updated_at: new Date().toISOString() })
      .eq("id", input.accountId).eq("tenant_id", tenantId).is("archived_at", null);
    dbFail(error, "Ad account could not be updated — refresh the page and try again.");
    return {};
  },
);

const removeSchema = z.object({ accountId: z.string().uuid() });

export const DELETE = withRoute(
  { route: "api/marketing/ads", input: removeSchema, roles: ["owner", "manager"] },
  async ({ input, tenantId, user }) => {
    const now = new Date().toISOString();
    const { data, error } = await createAdminClientFor(user.id).from("ad_accounts")
      .update({ archived_at: now, enabled: false, access_token: null, token_expires_at: null, connected_user_id: null, updated_at: now })
      .eq("id", input.accountId).eq("tenant_id", tenantId).is("archived_at", null)
      .select("id").maybeSingle();
    dbFail(error, "Ad account could not be removed — refresh the page and try again.");
    if (!data) throw new RouteError(404, "Ad account was not found — refresh the page.");
    return {};
  },
);
