import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { pagePhotoId, pagePhotoRef } from "./social-autopilot";

export type SocialPlatform = "facebook" | "instagram";
export type SocialFormat = "post" | "story";
export type SocialStatus = "draft" | "review" | "approved" | "publishing" | "published" | "failed";
export type SocialItem = {
  id: string; platform: SocialPlatform; format: SocialFormat; caption: string; media_url: string | null;
  topic: string; origin: string; status: SocialStatus; created_by: string | null; reviewed_by: string | null;
  reviewed_at: Date | null; published_at: Date | null; external_id: string | null; error: string | null; created_at: Date;
  /** R-2705 / R-2706 (only in listSocial). */
  post_type?: string | null; stats?: { reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null } | null;
  scheduled_at: Date | null;
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
      reviewed_by, reviewed_at, published_at, external_id, error, created_at, scheduled_at, post_type, stats
    from public.social_content where tenant_id = ${session.tenantId}::uuid
    order by created_at desc limit 100`);
}

export async function createSocial(session: TenantSession, input: {
  platform: SocialPlatform; format: SocialFormat; caption: string; mediaUrl: string | null; topic: string; origin: "manual" | "ai" | "scheduled";
  scheduledAt?: Date | null;
  /** R-2513: "Send for approval" saves straight into review. R-2672: "approved" only for the AI
   *  autopilot, which the owner switched on (it then posts at scheduledAt). Never published here. */
  status?: "draft" | "review" | "approved";
  /** R-2705: the kind of post and the strategy version it followed (for the weekly learning). */
  postType?: string | null; strategyVersion?: number | null;
}): Promise<string> {
  const rows = await withTenant(session, tx => tx.$queryRaw<{ id: string }[]>`
    insert into public.social_content (tenant_id, platform, format, caption, media_url, topic, origin, created_by, scheduled_at, status, post_type, strategy_version)
    values (${session.tenantId}::uuid, ${input.platform}, ${input.format}, ${input.caption}, ${input.mediaUrl}, ${input.topic}, ${input.origin}, ${session.userId}::uuid, ${input.scheduledAt ?? null}::timestamptz, ${input.status ?? "draft"}, ${input.postType ?? null}, ${input.strategyVersion ?? null}::int)
    returning id`);
  return rows[0].id;
}

export async function updateSocial(session: TenantSession, id: string, patch: {
  caption?: string; mediaUrl?: string | null; topic?: string; status?: SocialStatus;
  /** R-2510: undefined keeps the post time, null clears it. */
  scheduledAt?: Date | null;
}, expectedStatus: SocialStatus, reviewer = false): Promise<SocialItem | null> {
  const rows = await withTenant(session, tx => tx.$queryRaw<SocialItem[]>`
    update public.social_content set
      caption = coalesce(${patch.caption ?? null}, caption),
      media_url = case when ${patch.mediaUrl === undefined} then media_url else ${patch.mediaUrl ?? null} end,
      topic = coalesce(${patch.topic ?? null}, topic),
      scheduled_at = case when ${patch.scheduledAt === undefined} then scheduled_at else ${patch.scheduledAt ?? null}::timestamptz end,
      status = coalesce(${patch.status ?? null}, status),
      reviewed_by = case when ${reviewer} then ${session.userId}::uuid else reviewed_by end,
      reviewed_at = case when ${reviewer} then now() else reviewed_at end,
      error = case when ${patch.status ?? null} = 'draft' then null else error end,
      updated_at = now()
    where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid
      and status = ${expectedStatus}
    returning id, platform, format, caption, media_url, topic, origin, status, created_by,
      reviewed_by, reviewed_at, published_at, external_id, error, created_at, scheduled_at`);
  return rows[0] ?? null;
}

export async function claimApproved(session: TenantSession, id: string): Promise<SocialItem | null> {
  const rows = await withTenant(session, tx => tx.$queryRaw<SocialItem[]>`
    update public.social_content set status = 'publishing', updated_at = now()
    where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid and status = 'approved'
    returning id, platform, format, caption, media_url, topic, origin, status, created_by,
      reviewed_by, reviewed_at, published_at, external_id, error, created_at, scheduled_at`);
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

/* 5 Nov 2026: ask only for id + username. The Graph API has no `account_type` on an Instagram
   business account, and asking for it made Meta refuse the whole call — so a linked account
   always looked "not linked". */
export async function instagramForPage(pageId: string, pageToken: string): Promise<{ id: string; username?: string } | null> {
  const url = `${GRAPH}/${encodeURIComponent(pageId)}?${new URLSearchParams({ fields: "instagram_business_account{id,username}", access_token: pageToken })}`;
  const response = await fetch(url, { cache: "no-store" });
  const json = await response.json().catch(() => ({})) as { instagram_business_account?: { id: string; username?: string } };
  if (!response.ok) return null;
  return json.instagram_business_account ?? null;
}

/** R-2687: today's follower count of the Page and its Instagram account (null when Meta does not say). */
export async function metaFollowers(pageId: string, pageToken: string, instagramId: string | null): Promise<{ facebook: number | null; instagram: number | null }> {
  const get = async (id: string, fields: string) => {
    try {
      const r = await fetch(`${GRAPH}/${encodeURIComponent(id)}?${new URLSearchParams({ fields, access_token: pageToken })}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      return r.ok ? await r.json() as { followers_count?: number; fan_count?: number } : null;
    } catch { return null; }
  };
  const [fb, ig] = await Promise.all([get(pageId, "followers_count,fan_count"), instagramId ? get(instagramId, "followers_count") : Promise.resolve(null)]);
  return { facebook: fb?.followers_count ?? fb?.fan_count ?? null, instagram: ig?.followers_count ?? null };
}

/**
 * R-2697: keep a picture as a hidden (unpublished) photo on the Page — it does not show on the
 * Page, works from localhost, and gives Instagram a public link. Returns pagePhotoRef(<id>).
 */
export async function uploadPagePhoto(pageId: string, pageToken: string, bytes: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.set("published", "false");
  form.set("access_token", pageToken);
  form.set("source", new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === "image/jpeg" ? "picture.jpg" : "picture.png");
  const response = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(60_000) });
  const json = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!response.ok || !json.id) throw new Error(json.error?.message?.slice(0, 300) || `Meta returned ${response.status}.`);
  return pagePhotoRef(json.id);
}

/** R-2697: today's public link of each hidden Page photo (Meta's links expire after a few days). */
export async function pagePhotoLinks(refs: readonly (string | null)[], pageToken: string): Promise<Map<string, string>> {
  const ids = [...new Set(refs.map(pagePhotoId).filter((id): id is string => Boolean(id)))].slice(0, 40);
  const links = new Map<string, string>();
  if (!ids.length) return links;
  /* One call per photo: Meta refuses the batch "ids" query from v26 on. */
  await Promise.all(ids.map(async (id) => {
    try {
      const response = await fetch(`${GRAPH}/${id}?${new URLSearchParams({ fields: "images", access_token: pageToken })}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;
      const json = await response.json() as { images?: { source?: string; width?: number }[] };
      const best = [...(json.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.source;
      if (best) links.set(pagePhotoRef(id), best);
    } catch { /* the screen shows "no preview"; publishing reads it again */ }
  }));
  return links;
}

export function validMediaUrl(value: string | null): boolean {
  if (!value) return true;
  if (pagePhotoId(value)) return true;
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
  return publishWithPage(item, connection);
}

/**
 * Publish one approved item with the company's Page connection. Shared by "Publish now" (a
 * signed-in reviewer) and the R-2510 social-publish cron (scheduled posts). The caller has
 * already moved the row approved → publishing, so a post goes out at most once.
 */
export async function publishWithPage(
  item: Pick<SocialItem, "platform" | "format" | "caption" | "media_url">,
  connection: { pageId: string | null; pageToken: string | null },
): Promise<string> {
  if (!connection.pageId || !connection.pageToken) throw new Error("Connect your Facebook Page first.");
  const token = connection.pageToken;
  /* R-2697: an AI picture kept on the Page — take today's link just before posting. */
  if (pagePhotoId(item.media_url)) {
    const link = (await pagePhotoLinks([item.media_url], token)).get(item.media_url!);
    if (!link) throw new Error("The AI picture is no longer in your Facebook Page's photos. Edit the post and make a new picture.");
    item = { ...item, media_url: link };
  }
  if (item.platform === "facebook") {
    if (item.format !== "post") throw new Error("Facebook Stories are not available here yet.");
    if (item.media_url) return (await graphPost(`${connection.pageId}/photos`, { url: item.media_url, caption: item.caption, access_token: token })).id;
    return (await graphPost(`${connection.pageId}/feed`, { message: item.caption, access_token: token })).id;
  }
  const ig = await instagramForPage(connection.pageId, token);
  if (!ig) throw new Error("Link a professional Instagram account to this Facebook Page, then reconnect Meta.");
  if (!item.media_url) throw new Error("Instagram needs a public HTTPS image URL.");
  const container = await graphPost(`${ig.id}/media`, {
    image_url: item.media_url, ...(item.format === "story" ? { media_type: "STORIES" } : { caption: item.caption }), access_token: token,
  });
  return (await graphPost(`${ig.id}/media_publish`, { creation_id: container.id, access_token: token })).id;
}
