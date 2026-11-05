import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { metaAppCreds, exchangeMetaCode } from "@/lib/meta/meta-ads-api";
import { decryptTenantSecrets, sealTenantSecrets } from "@/lib/crypto/tenant-secrets";

const VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const PENDING_MS = 10 * 60 * 1000;
const COLUMNS = "tenant_id, facebook_page_pending_token, facebook_page_pending_at, facebook_page_access_token, facebook_page_id, facebook_page_name";

export function facebookPageRedirectUri(origin: string): string {
  return `${origin}/api/integrations/facebook-page/callback`;
}

export function facebookPageAuthUrl(appId: string, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId, redirect_uri: facebookPageRedirectUri(origin), state,
    scope: "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish", response_type: "code",
  });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${params}`;
}

export async function facebookPageCaller() {
  const client = createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  const { data } = await client.from("users").select("tenant_id,role").eq("id", user.id).maybeSingle();
  if (!data?.tenant_id) return null;
  return {
    userId: user.id, tenantId: data.tenant_id,
    canManage: mayDo(data.role, "integration.company"),
    admin: createAdminClientFor(user.id),
  };
}

type Admin = NonNullable<Awaited<ReturnType<typeof facebookPageCaller>>>["admin"];
type Connection = { pendingToken: string | null; pendingAt: string | null; pageToken: string | null; pageId: string | null; pageName: string | null };

export async function readFacebookPage(admin: Admin, tenantId: string): Promise<Connection> {
  const { data, error } = await admin.from("tenant_secrets").select(COLUMNS).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw error;
  const raw = decryptTenantSecrets(data as Record<string, unknown> | null);
  return {
    pendingToken: (raw?.facebook_page_pending_token as string | null) ?? null,
    pendingAt: (raw?.facebook_page_pending_at as string | null) ?? null,
    pageToken: (raw?.facebook_page_access_token as string | null) ?? null,
    pageId: (raw?.facebook_page_id as string | null) ?? null,
    pageName: (raw?.facebook_page_name as string | null) ?? null,
  };
}

export function pendingIsFresh(at: string | null): boolean {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) && time <= Date.now() && Date.now() - time < PENDING_MS;
}

export async function savePendingFacebookUser(admin: Admin, tenantId: string, token: string): Promise<void> {
  const { row } = sealTenantSecrets({
    tenant_id: tenantId, facebook_page_pending_token: token, facebook_page_pending_at: new Date().toISOString(),
  });
  const { error } = await admin.from("tenant_secrets").upsert(row, { onConflict: "tenant_id" });
  if (error) throw error;
}

export interface FacebookPageChoice { id: string; name: string; access_token: string; tasks?: string[] }

export async function listFacebookPages(userToken: string): Promise<FacebookPageChoice[]> {
  const pages: FacebookPageChoice[] = [];
  let url: string | undefined = `${GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,tasks", limit: "100", access_token: userToken })}`;
  while (url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Meta Page request failed (${response.status}).`);
    const result = await response.json() as { data?: FacebookPageChoice[]; paging?: { next?: string } };
    pages.push(...(result.data ?? []).filter((page) => page.id && page.name && page.access_token));
    const next: string | undefined = result.paging?.next;
    if (next && !next.startsWith(`${GRAPH}/`)) throw new Error("Meta returned an unexpected page link.");
    url = next;
  }
  return pages;
}

export async function selectFacebookPage(admin: Admin, tenantId: string, userId: string, page: FacebookPageChoice): Promise<void> {
  const { row } = sealTenantSecrets({
    tenant_id: tenantId, facebook_page_access_token: page.access_token,
    facebook_page_id: page.id, facebook_page_name: page.name,
    facebook_page_pending_token: null, facebook_page_pending_at: null,
    facebook_page_connected_at: new Date().toISOString(), facebook_page_connected_by: userId,
  });
  const { error } = await admin.from("tenant_secrets").upsert(row, { onConflict: "tenant_id" });
  if (error) throw error;
}

export async function disconnectFacebookPage(admin: Admin, tenantId: string): Promise<void> {
  const { error } = await admin.from("tenant_secrets").update({
    facebook_page_pending_token: null, facebook_page_pending_at: null,
    facebook_page_access_token: null, facebook_page_id: null, facebook_page_name: null,
    facebook_page_connected_at: null, facebook_page_connected_by: null,
  }).eq("tenant_id", tenantId);
  if (error) throw error;
}

export { metaAppCreds, exchangeMetaCode };
