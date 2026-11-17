/**
 * R-2706 (G-SOCIAL): read the results of posts that went out — Facebook reactions, comments,
 * shares and reach; Instagram likes, comments, reach and saves. Runs before the weekly plan (the
 * Monday cron and "Plan this week now"), for posts out at least RESULTS_AFTER_DAYS days.
 *
 * Reach and saves need the Page connection's read_insights / instagram_manage_insights
 * permissions (added 12 Nov 2026). Without them the counts are still read and the result says
 * "reconnect Facebook" — never a failed plan.
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { RESULTS_AFTER_DAYS, type PostStats } from "./social-strategy";

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v21.0"}`;

type Got = { json: Record<string, unknown> | null; noPermission: boolean };
async function get(path: string, params: Record<string, string>, token: string): Promise<Got> {
  try {
    const r = await fetch(`${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (r.ok) return { json, noPermission: false };
    const err = (json?.error ?? {}) as { code?: number; message?: string };
    return { json: null, noPermission: err.code === 10 || err.code === 200 || /permission/i.test(err.message ?? "") };
  } catch { return { json: null, noPermission: false }; }
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const insight = (json: Record<string, unknown> | null, name: string): number | null => {
  const data = (json?.data ?? []) as { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[];
  const row = data.find((d) => d.name === name);
  return num(row?.total_value?.value ?? row?.values?.[0]?.value);
};

/** One Facebook post (a photo post's id is the photo; its post is page_story_id). */
export async function facebookPostStats(externalId: string, token: string): Promise<{ stats: PostStats; noPermission: boolean }> {
  let postId = externalId;
  if (!externalId.includes("_")) {
    const story = await get(externalId, { fields: "page_story_id" }, token);
    if (typeof story.json?.page_story_id === "string") postId = story.json.page_story_id;
  }
  const [counts, reach] = await Promise.all([
    get(postId, { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares" }, token),
    get(`${postId}/insights`, { metric: "post_impressions_unique" }, token),
  ]);
  const c = counts.json as { reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } } | null;
  return {
    stats: {
      likes: num(c?.reactions?.summary?.total_count), comments: num(c?.comments?.summary?.total_count),
      shares: c ? num(c.shares?.count) ?? 0 : null, saves: null, reach: insight(reach.json, "post_impressions_unique"),
    },
    noPermission: reach.noPermission,
  };
}

/** One Instagram post. */
export async function instagramPostStats(mediaId: string, token: string): Promise<{ stats: PostStats; noPermission: boolean }> {
  const [counts, ins] = await Promise.all([
    get(mediaId, { fields: "like_count,comments_count" }, token),
    get(`${mediaId}/insights`, { metric: "reach,saved,shares" }, token),
  ]);
  return {
    stats: {
      likes: num(counts.json?.like_count), comments: num(counts.json?.comments_count),
      shares: insight(ins.json, "shares"), saves: insight(ins.json, "saved"), reach: insight(ins.json, "reach"),
    },
    noPermission: ins.noPermission,
  };
}

/**
 * Read results for this company's posts out RESULTS_AFTER_DAYS+ days (last 45 days), not read in
 * the last 2 days. At most 40 a run. Returns how many were read and whether permission is missing.
 */
export async function refreshPostStats(session: TenantSession, pageToken: string, now: Date = new Date(), pageId: string | null = null): Promise<{ read: number; noPermission: boolean }> {
  const before = new Date(now.getTime() - RESULTS_AFTER_DAYS * 86_400_000);
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ id: string; platform: string; external_id: string }[]>`
    select id, platform, external_id from public.social_content
    where tenant_id = ${session.tenantId}::uuid and status = 'published' and external_id is not null
      and (${pageId}::text is null or page_id = ${pageId})
      and published_at < ${before}::timestamptz and published_at > ${new Date(now.getTime() - 45 * 86_400_000)}::timestamptz
      and (stats_at is null or stats_at < ${new Date(now.getTime() - 2 * 86_400_000)}::timestamptz)
    order by published_at desc limit 40`);
  let read = 0;
  let noPermission = false;
  for (const row of rows) {
    const r = row.platform === "instagram" ? await instagramPostStats(row.external_id, pageToken) : await facebookPostStats(row.external_id, pageToken);
    noPermission ||= r.noPermission;
    if (r.stats.likes === null && r.stats.comments === null && r.stats.reach === null) continue; // Meta said nothing — try next week
    await withTenant(session, (tx) => tx.$executeRaw`
      update public.social_content set stats = ${JSON.stringify(r.stats)}::jsonb, stats_at = now()
      where id = ${row.id}::uuid and tenant_id = ${session.tenantId}::uuid`);
    read++;
  }
  return { read, noPermission };
}
