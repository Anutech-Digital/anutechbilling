import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";

export type SocialPlatform = "facebook" | "instagram";
export type SocialFormat = "post" | "story";
export type SocialStatus = "draft" | "review" | "approved" | "publishing" | "published" | "failed";
export type SocialItem = {
  id: string; platform: SocialPlatform; format: SocialFormat; caption: string; media_url: string | null;
  topic: string; origin: string; status: SocialStatus; created_by: string | null; reviewed_by: string | null;
  reviewed_at: Date | null; published_at: Date | null; external_id: string | null; error: string | null; created_at: Date;
};

export async function socialRole(session: TenantSession): Promise<string | null> {
  const rows = await withTenant(session, tx => tx.$queryRaw<{ role: string }[]>`
    select role::text from public.users where id = ${session.userId}::uuid and tenant_id = ${session.tenantId}::uuid and is_active = true limit 1`);
  return rows[0]?.role ?? null;
}

export function canWriteSocial(role: string | null): boolean {
  return role === "owner" || role === "manager" || role === "marketing";
}
export function canReviewSocial(role: string | null): boolean {
  return role === "owner" || role === "manager";
}

export async function listSocial(session: TenantSession): Promise<SocialItem[]> {
  return withTenant(session, tx => tx.$queryRaw<SocialItem[]>`
    select id, platform, format, caption, media_url, topic, origin, status, created_by,
      reviewed_by, reviewed_at, published_at, external_id, error, created_at
    from public.social_content where tenant_id = ${session.tenantId}::uuid
    order by created_at desc limit 100`);
}

export async function createSocial(session: TenantSession, input: {
  platform: SocialPlatform; format: SocialFormat; caption: string; mediaUrl: string | null; topic: string; origin: "manual" | "ai" | "scheduled";
}): Promise<string> {
  const rows = await withTenant(session, tx => tx.$queryRaw<{ id: string }[]>`
    insert into public.social_content (tenant_id, platform, format, caption, media_url, topic, origin, created_by)
    values (${session.tenantId}::uuid, ${input.platform}, ${input.format}, ${input.caption}, ${input.mediaUrl}, ${input.topic}, ${input.origin}, ${session.userId}::uuid)
    returning id`);
  return rows[0].id;
}

export async function updateSocial(session: TenantSession, id: string, patch: {
  caption?: string; mediaUrl?: string | null; topic?: string; status?: SocialStatus;
}, expectedStatus: SocialStatus, reviewer = false): Promise<SocialItem | null> {
  const rows = await withTenant(session, tx => tx.$queryRaw<SocialItem[]>`
    update public.social_content set
      caption = coalesce(${patch.caption ?? null}, caption),
      media_url = case when ${patch.mediaUrl === undefined} then media_url else ${patch.mediaUrl ?? null} end,
      topic = coalesce(${patch.topic ?? null}, topic),
      status = coalesce(${patch.status ?? null}, status),
      reviewed_by = case when ${reviewer} then ${session.userId}::uuid else reviewed_by end,
      reviewed_at = case when ${reviewer} then now() else reviewed_at end,
      error = case when ${patch.status ?? null} = 'draft' then null else error end,
      updated_at = now()
    where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid
      and status = ${expectedStatus}
    returning id, platform, format, caption, media_url, topic, origin, status, created_by,
      reviewed_by, reviewed_at, published_at, external_id, error, created_at`);
  return rows[0] ?? null;
}

export async function claimApproved(session: TenantSession, id: string): Promise<SocialItem | null> {
  const rows = await withTenant(session, tx => tx.$queryRaw<SocialItem[]>`
    update public.social_content set status = 'publishing', updated_at = now()
    where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid and status = 'approved'
    returning id, platform, format, caption, media_url, topic, origin, status, created_by,
      reviewed_by, reviewed_at, published_at, external_id, error, created_at`);
  return rows[0] ?? null;
}

export async function completePublish(session: TenantSession, id: string, externalId: string | null, error: string | null): Promise<void> {
  await withTenant(session, tx => tx.$executeRaw`
    update public.social_content set status = ${error ? "failed" : "published"}, external_id = ${externalId},
      error = ${error}, published_by = ${session.userId}::uuid,
      published_at = case when ${error ? false : true} then now() else null end, updated_at = now()
    where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid and status = 'publishing'`);
}

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v21.0"}`;
async function graphPost(path: string, fields: Record<string, string>): Promise<{ id: string }> {
  const response = await fetch(`${GRAPH}/${path}`, { method: "POST", body: new URLSearchParams(fields), cache: "no-store" });
  const json = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!response.ok || !json.id) throw new Error(json.error?.message?.slice(0, 300) || `Meta returned ${response.status}.`);
  return { id: json.id };
}

export async function instagramForPage(pageId: string, pageToken: string): Promise<{ id: string; username?: string; account_type?: string } | null> {
  const url = `${GRAPH}/${encodeURIComponent(pageId)}?${new URLSearchParams({ fields: "instagram_business_account{id,username,account_type}", access_token: pageToken })}`;
  const response = await fetch(url, { cache: "no-store" });
  const json = await response.json().catch(() => ({})) as { instagram_business_account?: { id: string; username?: string; account_type?: string } };
  if (!response.ok) return null;
  return json.instagram_business_account ?? null;
}

export function validMediaUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(url.hostname);
  } catch { return false; }
}

export async function publishSocial(session: TenantSession, item: SocialItem): Promise<string> {
  const admin = createClient();
  const { data: { user } } = await admin.auth.getUser();
  if (!user || user.id !== session.userId) throw new Error("Sign in again.");
  const { createAdminClientFor } = await import("@/lib/supabase/server");
  const connection = await readFacebookPage(createAdminClientFor(session.userId), session.tenantId);
  if (!connection.pageId || !connection.pageToken) throw new Error("Connect your Facebook Page first.");
  const token = connection.pageToken;
  if (item.platform === "facebook") {
    if (item.format !== "post") throw new Error("Facebook Stories are not available here yet.");
    if (item.media_url) return (await graphPost(`${connection.pageId}/photos`, { url: item.media_url, caption: item.caption, access_token: token })).id;
    return (await graphPost(`${connection.pageId}/feed`, { message: item.caption, access_token: token })).id;
  }
  const ig = await instagramForPage(connection.pageId, token);
  if (!ig) throw new Error("Link a professional Instagram account to this Facebook Page, then reconnect Meta.");
  if (item.format === "story" && ig.account_type !== "BUSINESS") throw new Error("Instagram Stories require a Business account.");
  if (!item.media_url) throw new Error("Instagram needs a public HTTPS image URL.");
  const container = await graphPost(`${ig.id}/media`, {
    image_url: item.media_url, ...(item.format === "story" ? { media_type: "STORIES" } : { caption: item.caption }), access_token: token,
  });
  return (await graphPost(`${ig.id}/media_publish`, { creation_id: container.id, access_token: token })).id;
}
