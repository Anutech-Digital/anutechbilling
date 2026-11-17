/**
 * R-2689 / R-2690 (G-SOCIAL): comments and followers on the company's Facebook Page and Instagram.
 *
 * Used by the social-publish cron (every 10 min: followers once a day, comments at most every
 * COMMENT_CHECK_MINUTES) and by the page's buttons. Takes an UNTYPED service-role client, so every
 * query filters by tenant_id itself (RLS is bypassed). Callers check the person's role.
 *
 * Meta permissions (12–13 Nov 2026, measured on the connected Page token): reading comments needs
 * pages_read_user_content (Facebook) and instagram_manage_comments (Instagram); replying needs
 * pages_manage_engagement / instagram_manage_comments. Without them the result says so and the page
 * shows which permissions to add — never a silent empty list.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { pageConnection, listPages } from "./social-pages.server";
import { istToday } from "@/lib/dates/ist";
import { metaFollowers, instagramForPage } from "./social-content";
import { logSystemActivity } from "./social-activity";
import {
  COMMENT_CHECK_MINUTES, aiMaySend, cleanReply, normaliseKind, type CommentKind, type CommentMode,
} from "./social-engagement";

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v21.0"}`;
/** R-2729: always one Page's connection (its id + token). */
type Connection = { pageId: string; pageToken: string };
/** The typed service-role client, for helpers that take it (same object as the untyped one). */
const typed = (admin: SupabaseClient) => admin as unknown as ReturnType<typeof createAdminClient>;

export const COMMENT_PERMISSION_HELP = "Meta has not given this app permission to read or answer comments. In the Meta app (developers.facebook.com → your app → Use cases → Customize) add pages_read_user_content and pages_manage_engagement (Facebook Page) and instagram_manage_comments (Instagram), then reconnect the Facebook Page.";

async function graph(path: string, params: Record<string, string>, token: string, method: "GET" | "POST" = "GET"): Promise<{ json: Record<string, unknown> | null; noPermission: boolean; error: string | null }> {
  try {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const r = method === "GET"
      ? await fetch(`${GRAPH}/${path}?${qs}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
      : await fetch(`${GRAPH}/${path}`, { method: "POST", body: qs, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (r.ok) return { json, noPermission: false, error: null };
    const err = (json?.error ?? {}) as { code?: number; message?: string };
    return { json: null, noPermission: err.code === 10 || err.code === 200 || /permission/i.test(err.message ?? ""), error: (err.message ?? `Meta returned ${r.status}.`).slice(0, 300) };
  } catch (e) {
    return { json: null, noPermission: false, error: e instanceof Error ? e.message.slice(0, 300) : "Meta did not answer." };
  }
}

// ── R-2690: followers ───────────────────────────────────────────────────────────────────────

/** Save today's follower count (once a day is enough; a second call the same day updates it). */
export async function snapshotFollowers(admin: SupabaseClient, tenantId: string, connection: Connection, now: Date = new Date()): Promise<{ facebook: number | null; instagram: number | null }> {
  if (!connection.pageId || !connection.pageToken) return { facebook: null, instagram: null };
  const ig = await instagramForPage(connection.pageId, connection.pageToken).catch(() => null);
  const counts = await metaFollowers(connection.pageId, connection.pageToken, ig?.id ?? null);
  const day = istToday(now);
  const rows = (["facebook", "instagram"] as const).flatMap((p) => (counts[p] !== null ? [{ tenant_id: tenantId, platform: p, day, followers: counts[p] }] : []));
  if (rows.length) {
    const { error } = await admin.from("social_followers").upsert(rows.map((r) => ({ ...r, page_id: connection.pageId })), { onConflict: "tenant_id,page_id,platform,day" });
    if (error) console.error("[social-followers] save failed", error.message);
  }
  await admin.from("social_pages").update({ followers_checked_on: day }).eq("tenant_id", tenantId).eq("page_id", connection.pageId);
  return counts;
}

// ── R-2689: comments ────────────────────────────────────────────────────────────────────────

/** Read new comments on the company's posts of the last 30 days. */
export async function fetchComments(admin: SupabaseClient, tenantId: string, connection: Connection, now: Date = new Date()): Promise<{ added: number; noPermission: boolean }> {
  if (!connection.pageId || !connection.pageToken) return { added: 0, noPermission: false };
  const token = connection.pageToken;
  const { data: posts } = await admin.from("social_content").select("id, platform, external_id")
    .eq("tenant_id", tenantId).eq("page_id", connection.pageId).eq("status", "published").not("external_id", "is", null)
    .gte("published_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).limit(40);
  let noPermission = false;
  const found: Record<string, unknown>[] = [];
  for (const post of (posts ?? []) as { id: string; platform: string; external_id: string }[]) {
    if (post.platform === "facebook") {
      let postId = post.external_id;
      if (!postId.includes("_")) {
        const story = await graph(postId, { fields: "page_story_id" }, token);
        if (typeof story.json?.page_story_id === "string") postId = story.json.page_story_id;
      }
      const r = await graph(`${postId}/comments`, { fields: "id,message,from{id,name},created_time", filter: "toplevel", order: "reverse_chronological", limit: "50" }, token);
      noPermission ||= r.noPermission;
      for (const c of ((r.json?.data ?? []) as { id: string; message?: string; from?: { id?: string; name?: string }; created_time?: string }[])) {
        if (c.from?.id === connection.pageId || !c.message?.trim()) continue; // the Page's own replies
        found.push({ tenant_id: tenantId, page_id: connection.pageId, platform: "facebook", external_id: c.id, post_external_id: post.external_id, content_id: post.id, author: (c.from?.name ?? "Someone").slice(0, 200), message: c.message.slice(0, 4000), commented_at: c.created_time ?? null });
      }
    } else if (post.platform === "instagram") {
      const r = await graph(`${post.external_id}/comments`, { fields: "id,text,username,timestamp", limit: "50" }, token);
      noPermission ||= r.noPermission;
      for (const c of ((r.json?.data ?? []) as { id: string; text?: string; username?: string; timestamp?: string }[])) {
        if (!c.text?.trim()) continue;
        found.push({ tenant_id: tenantId, page_id: connection.pageId, platform: "instagram", external_id: c.id, post_external_id: post.external_id, content_id: post.id, author: (c.username ? `@${c.username}` : "Someone").slice(0, 200), message: c.text.slice(0, 4000), commented_at: c.timestamp ?? null });
      }
    }
  }
  let added = 0;
  if (found.length) {
    const { data, error } = await admin.from("social_comments").upsert(found, { onConflict: "tenant_id,platform,external_id", ignoreDuplicates: true }).select("id");
    if (error) console.error("[social-comments] save failed", error.message);
    added = (data ?? []).length;
  }
  await admin.from("social_pages").update({ comments_checked_at: now.toISOString(), comments_problem: noPermission ? COMMENT_PERMISSION_HELP : null }).eq("tenant_id", tenantId).eq("page_id", connection.pageId);
  return { added, noPermission };
}

/** Send one reply to Meta and record it. `by` = the AI or a person (their user id). */
export async function sendReply(admin: SupabaseClient, tenantId: string, connection: { pageId: string | null; pageToken: string | null }, commentId: string, text: string, by: { actor: "ai" } | { actor: "person"; userId: string; name: string }): Promise<{ ok: true } | { ok: false; error: string; noPermission: boolean }> {
  const reply = cleanReply(text);
  if (!reply) return { ok: false, error: "Write the reply first.", noPermission: false };
  const { data: row } = await admin.from("social_comments").select("id, platform, external_id, status, message, page_id")
    .eq("tenant_id", tenantId).eq("id", commentId).maybeSingle();
  const c = row as { id: string; platform: string; external_id: string; status: string; message: string; page_id: string | null } | null;
  if (!c) return { ok: false, error: "Comment not found. Refresh the page.", noPermission: false };
  /* R-2729: reply as the Page the comment was made on. */
  if (c.page_id && c.page_id !== connection.pageId) connection = await pageConnection(admin, tenantId, c.page_id);
  if (!connection.pageToken) return { ok: false, error: "This Page is not connected. Reconnect Facebook.", noPermission: false };
  if (c.status === "replied") return { ok: false, error: "This comment already has a reply.", noPermission: false };
  const r = await graph(c.platform === "instagram" ? `${c.external_id}/replies` : `${c.external_id}/comments`, { message: reply }, connection.pageToken, "POST");
  const ok = !r.error;
  await admin.from("social_comments").update(ok
    ? { status: "replied", reply, replied_by: by.actor, replied_user: by.actor === "person" ? by.userId : null, replied_at: new Date().toISOString(), error: null }
    : { status: "failed", error: r.error }).eq("tenant_id", tenantId).eq("id", c.id);
  await logSystemActivity(admin, tenantId, {
    actor: by.actor === "ai" ? "ai" : "person", platform: c.platform as "facebook" | "instagram", pageId: c.page_id,
    userId: by.actor === "person" ? by.userId : null,
    action: ok ? "Replied to a comment" : "Reply failed", detail: `${ok ? reply : r.error} — on “${c.message.slice(0, 60)}”`.slice(0, 500), result: ok ? "ok" : "failed",
  });
  if (!ok && r.noPermission && c.page_id) await admin.from("social_pages").update({ comments_problem: COMMENT_PERMISSION_HELP }).eq("tenant_id", tenantId).eq("page_id", c.page_id);
  return ok ? { ok: true } : { ok: false, error: r.error!, noPermission: r.noPermission };
}

/** The AI reads new comments: kind + a draft reply. On Autopilot it sends the safe ones itself. */
export async function draftReplies(admin: SupabaseClient, tenantId: string, connection: Connection, opts: { mode: CommentMode; aiPaused: boolean; brief: string }): Promise<{ drafted: number; sent: number }> {
  const { data } = await admin.from("social_comments").select("id, platform, author, message").eq("tenant_id", tenantId).eq("page_id", connection.pageId).eq("status", "new").order("commented_at", { ascending: true }).limit(10);
  const fresh = (data ?? []) as { id: string; platform: string; author: string; message: string }[];
  if (!fresh.length || opts.aiPaused) return { drafted: 0, sent: 0 };
  const ai = await resolveGeminiConfig(typed(admin), tenantId);
  if (!ai.apiKey) return { drafted: 0, sent: 0 };
  const result = await geminiJson<{ replies?: { id?: string; kind?: string; reply?: string }[] }>({
    apiKey: ai.apiKey, model: ai.model, tenantId, label: "marketing/social-comments", temperature: 0.4,
    system: "You answer comments on a B2B cloud services reseller's own Facebook/Instagram posts, as the company. For each comment return {\"id\",\"kind\":\"question|praise|complaint|spam|other\",\"reply\"}. Replies: short (1-3 sentences), warm, helpful, honest, in the comment's language. Never promise prices, discounts, dates or results; for a price or account question invite them to message the Page. No links. For spam reply \"\". Return JSON {\"replies\":[…]}.",
    user: `Business: ${opts.brief || "cloud services reseller (Google Workspace, Microsoft 365, Zoho)"}\nComments:\n${fresh.map((c) => JSON.stringify({ id: c.id, platform: c.platform, author: c.author, comment: c.message.slice(0, 600) })).join("\n")}`,
  });
  let drafted = 0, sent = 0;
  for (const r of result?.replies ?? []) {
    const c = fresh.find((f) => f.id === r.id);
    if (!c) continue;
    const kind: CommentKind = normaliseKind(r.kind);
    const reply = cleanReply(r.reply);
    await admin.from("social_comments").update({ kind, ai_reply: reply || null, status: "draft" }).eq("tenant_id", tenantId).eq("id", c.id).eq("status", "new");
    drafted++;
    if (reply && aiMaySend(opts.mode, kind, opts.aiPaused)) {
      const s = await sendReply(admin, tenantId, connection, c.id, reply, { actor: "ai" });
      if (s.ok) sent++;
    }
  }
  if (drafted - sent > 0 && opts.mode !== "off") {
    await logSystemActivity(admin, tenantId, { actor: "ai", pageId: connection.pageId, action: "Wrote replies to comments", detail: `${drafted - sent} waiting for you in Comments`, result: "waiting" });
  }
  return { drafted, sent };
}

/**
 * The cron's sweep for one company: followers once a day; comments every COMMENT_CHECK_MINUTES
 * when comment replies are not Off. Never throws.
 */
export async function engagementSweep(admin: SupabaseClient, tenantId: string, now: Date = new Date()): Promise<void> {
  try {
    const { data } = await admin.from("social_content_settings").select("ai_paused").eq("tenant_id", tenantId).maybeSingle();
    const aiPaused = Boolean((data as { ai_paused?: boolean } | null)?.ai_paused);
    /* R-2729: every Page the company switched on, each with its own settings. */
    for (const page of await listPages(admin, tenantId, { activeOnly: true })) {
      const c = await pageConnection(admin, tenantId, page.page_id);
      if (!c.pageId || !c.pageToken) continue;
      const connection = { pageId: c.pageId, pageToken: c.pageToken };
      if (page.followers_checked_on !== istToday(now)) await snapshotFollowers(admin, tenantId, connection, now);
      const due = !page.comments_checked_at || now.getTime() - new Date(page.comments_checked_at).getTime() >= COMMENT_CHECK_MINUTES * 60_000;
      if (page.comment_mode !== "off" && due) {
        await fetchComments(admin, tenantId, connection, now);
        await draftReplies(admin, tenantId, connection, { mode: page.comment_mode, aiPaused, brief: page.brief });
      }
    }
  } catch (e) {
    console.error("[social-engagement] sweep failed", e instanceof Error ? e.message : "unknown");
  }
}
