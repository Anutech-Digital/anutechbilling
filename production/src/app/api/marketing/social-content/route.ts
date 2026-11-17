/**
 * /api/marketing/social-content — Social growth.
 * GET ?page=<Facebook Page id>|all — R-2729: one Page's posts, AI settings, strategy, followers,
 *   report, comments and activity; or "all" = every Page the company switched on, side by side.
 * POST — a person writes a post (or "Write with AI" fills the boxes) for one Page.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { canReviewSocial, canWriteSocial, createSocial, metaFollowers, pagePhotoLinks, socialRole, uploadPagePhoto, validMediaUrl, listSocial } from "@/lib/marketing/social-content";
import { listActivity, logPersonActivity } from "@/lib/marketing/social-activity";
import { readLinkedInConnection } from "@/lib/integrations/linkedin/store";
import { parseIstLocal, scheduleProblem } from "@/lib/marketing/social-schedule";
import { planFor, readStrategies } from "@/lib/marketing/social-strategy.server";
import { describePlan } from "@/lib/marketing/social-strategy";
import { followerRows, latestReport, readTodo } from "@/lib/marketing/social-report.server";
import { followerTrend } from "@/lib/marketing/social-engagement";
import { fillPagesFromTokens, listPages, pageConnection, resolvePage, type SocialPage } from "@/lib/marketing/social-pages.server";
import { pagePhotoId } from "@/lib/marketing/social-autopilot";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PageId = z.string().regex(/^\d{1,30}$/, "Choose a Page.");
const draft = z.object({
  platform: z.enum(["facebook", "instagram"]), format: z.enum(["post", "story"]),
  caption: z.string().trim().max(2200).default(""), mediaUrl: z.string().trim().max(2000).nullable().default(null),
  topic: z.string().trim().max(500).default(""), ai: z.boolean().default(false),
  /* R-2510: post time as typed in the form ("2026-11-06T09:00", India time). */
  scheduledAt: z.string().trim().max(16).nullable().default(null),
  /* R-2513 / R-2709: "Schedule post" — save and schedule in one step (approved; no approval needed). */
  submit: z.boolean().default(false),
  /* R-2513: "Write with AI" only fills the caption box — nothing is saved until the person sends it. */
  previewOnly: z.boolean().default(false),
  /* R-2705: Write with AI for these places — one text each, from each platform's strategy. */
  platforms: z.array(z.enum(["facebook", "instagram"])).max(2).optional(),
  /* R-2729: the Page it is for (the main Page when left out). */
  pageId: PageId.optional(),
  /* R-2731: the same post on another Page — the AI rewrites the text for that Page's brief and strategy. */
  adapt: z.boolean().default(false),
  /* R-2731: the Page whose photos hold an AI picture (it is copied to `pageId` when different). */
  mediaPageId: PageId.optional(),
});

type CommentRow = { id: string; platform: string; author: string; message: string; commented_at: Date | null; kind: string | null; status: string; ai_reply: string | null; reply: string | null; replied_by: string | null; replied_at: Date | null; error: string | null; content_id: string | null; page_id: string | null };
const PLATFORMS = ["facebook", "instagram", "linkedin"] as const;
const pageView = (p: SocialPage) => ({ page_id: p.page_id, name: p.name, instagram_username: p.instagram_username, active: p.active, is_main: p.is_main });

export async function GET(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Only the marketing team can view social content." }, { status: 403 });
  const typed = createAdminClientFor(session.userId);
  const admin = typed as unknown as SupabaseClient;
  const requested = new URL(req.url).searchParams.get("page");
  try {
    /* R-2729: Pages whose token was saved but not listed yet (or never checked for Instagram) are filled in. */
    await fillPagesFromTokens(admin, session.tenantId);
    const [allPages, paused, linkedin, todo] = await Promise.all([
      listPages(admin, session.tenantId),
      withTenant(session, tx => tx.$queryRaw<{ ai_paused: boolean }[]>`select ai_paused from public.social_content_settings where tenant_id = ${session.tenantId}::uuid`),
      readLinkedInConnection(typed, session.tenantId).catch(() => null),
      readTodo(session).catch(() => null),
    ]);
    const active = allPages.filter((p) => p.active);
    const all = requested === "all" && active.length > 0;
    const page = all ? null : await resolvePage(admin, session.tenantId, requested);
    const pageId = page?.page_id ?? null;
    const today = istToday();
    const aiReady = Boolean((await resolveGeminiConfig(createClient(), session.tenantId)).apiKey);
    const common = {
      pages: allPages.map(pageView), view: all ? "all" : pageId, ai_paused: Boolean(paused[0]?.ai_paused), todo, aiReady,
      canReview: canReviewSocial(role), canManage: role === "owner",
      linkedin: linkedin?.organizationUrn ? { name: linkedin.organizationName ?? "LinkedIn Page" } : null,
    };
    const commentsSql = (forPage: string | null) => withTenant(session, tx => tx.$queryRaw<CommentRow[]>`
      select id, platform, author, message, commented_at, kind, status, ai_reply, reply, replied_by, replied_at, error, content_id, page_id
      from public.social_comments where tenant_id = ${session.tenantId}::uuid and status <> 'ignored'
        and (${forPage}::text is null or page_id = ${forPage})
      order by coalesce(commented_at, created_at) desc limit 80`).catch(() => [] as CommentRow[]);

    if (all) {
      // R-2731: every Page at a glance — from saved counts (no live Meta call per Page).
      const [items, activity, comments, rows] = await Promise.all([
        listSocial(session, null), listActivity(session, 80, null).catch(() => []), commentsSql(null), followerRows(session, 60, null).catch(() => []),
      ]);
      const overview = active.map((p) => {
        const mine = rows.filter((r) => r.page_id === p.page_id);
        return { ...pageView(p),
          trends: Object.fromEntries(PLATFORMS.map((pl) => [pl, followerTrend(mine, pl, today)])),
          waiting: items.filter((i) => i.page_id === p.page_id && i.status === "review").length,
          scheduled: items.filter((i) => i.page_id === p.page_id && i.status === "approved").length,
          comments: comments.filter((c) => c.page_id === p.page_id && c.status !== "replied").length,
          autopilot: p.autopilot, auto_drafts: p.auto_drafts, comment_mode: p.comment_mode };
      });
      const settings = { auto_drafts: false, brief: "", autopilot: false, posts_per_week: 3, picture_urls: [], last_generated_on: null, ai_paused: common.ai_paused, comment_mode: "ask", comments_problem: null };
      return NextResponse.json({ ...common, overview, items, activity, comments, settings, strategies: null, trends: null, report: null,
        followers: { facebook: null, instagram: null }, facebook: null, instagram: null });
    }

    // One Page (or none connected yet).
    let connection: { pageId: string | null; pageToken: string | null; pageName?: string | null } = await pageConnection(admin, session.tenantId, pageId);
    if (!connection.pageToken) { const main = await readFacebookPage(typed, session.tenantId); if (!pageId || main.pageId === pageId) connection = main; }
    const items = await listSocial(session, pageId);
    const [followers, activity, photoLinks, strategies, comments] = await Promise.all([
      connection.pageId && connection.pageToken ? metaFollowers(connection.pageId, connection.pageToken, page?.instagram_id ?? null) : Promise.resolve({ facebook: null, instagram: null }),
      listActivity(session, 60, pageId).catch(() => []),
      // R-2697: AI pictures kept on the Page — today's link to show them.
      connection.pageToken ? pagePhotoLinks(items.map((i) => i.media_url), connection.pageToken) : Promise.resolve(new Map<string, string>()),
      pageId ? readStrategies(session, pageId).catch(() => null) : Promise.resolve(null), // R-2705
      commentsSql(pageId),
    ]);
    // R-2690: today's follower count is saved whenever the Page is opened (the cron also saves it daily).
    if (pageId) for (const p of (["facebook", "instagram"] as const).filter((x) => followers[x] !== null)) {
      await withTenant(session, tx => tx.$executeRaw`
        insert into public.social_followers (tenant_id, page_id, platform, day, followers) values (${session.tenantId}::uuid, ${pageId}, ${p}, ${today}::date, ${followers[p]}::int)
        on conflict (tenant_id, page_id, platform, day) do update set followers = excluded.followers`).catch(() => undefined);
    }
    const [rows, report] = await Promise.all([
      pageId ? followerRows(session, 60, pageId).catch(() => []) : Promise.resolve([]),
      pageId ? latestReport(session, pageId).catch(() => null) : Promise.resolve(null),
    ]);
    const trends = Object.fromEntries(PLATFORMS.map((p) => [p, followerTrend(rows, p, today)]));
    const settings = page ? {
      auto_drafts: page.auto_drafts, brief: page.brief, autopilot: page.autopilot, posts_per_week: page.posts_per_week, picture_urls: page.picture_urls,
      last_generated_on: page.last_generated_on, ai_paused: common.ai_paused, comment_mode: page.comment_mode, comments_problem: page.comments_problem,
    } : { auto_drafts: false, brief: "", autopilot: false, posts_per_week: 3, picture_urls: [], last_generated_on: null, ai_paused: common.ai_paused, comment_mode: "ask", comments_problem: null };
    return NextResponse.json({ ...common, overview: null,
      items: items.map((i) => ({ ...i, media_preview: i.media_url ? photoLinks.get(i.media_url) ?? null : null })),
      settings, followers, activity, strategies, trends, report, comments,
      facebook: connection.pageId ? { name: page?.name || connection.pageName || "Facebook Page", connected: true, id: connection.pageId } : null,
      instagram: page?.instagram_id ? { name: page.instagram_username ?? "Instagram", type: null } : null });
  } catch (error) {
    console.error("[social-content] load failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not load social content. Apply the latest database migration and retry." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Marketing access required." }, { status: 403 });
  const parsed = draft.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid draft." }, { status: 400 });
  const input = parsed.data;
  if (input.platform === "facebook" && input.format === "story") return NextResponse.json({ error: "Facebook Stories are not supported here yet. Choose a Facebook post or Instagram Story." }, { status: 400 });
  if (!validMediaUrl(input.mediaUrl)) return NextResponse.json({ error: "Use a public HTTPS media URL." }, { status: 400 });
  const scheduledAt = input.scheduledAt ? parseIstLocal(input.scheduledAt) : null;
  if (input.scheduledAt && !scheduledAt) return NextResponse.json({ error: "Choose a valid post date and time." }, { status: 400 });
  const timeProblem = scheduledAt ? scheduleProblem(scheduledAt) : null;
  if (timeProblem) return NextResponse.json({ error: timeProblem }, { status: 400 });
  if (!input.previewOnly && (input.platform === "instagram" || input.format === "story") && !input.mediaUrl) return NextResponse.json({ error: "Instagram posts and stories need an image URL." }, { status: 400 });
  const admin = createAdminClientFor(session.userId) as unknown as SupabaseClient;
  const page = await resolvePage(admin, session.tenantId, input.pageId ?? null);
  if (input.pageId && page?.page_id !== input.pageId) return NextResponse.json({ error: "This Page is not switched on for Social growth.", description: "Open Manage Pages and switch it on." }, { status: 409 });
  const pageId = page?.page_id ?? null;
  let caption = input.caption;
  let origin: "manual" | "ai" = "manual";
  if (input.ai || input.adapt) {
    if (input.ai && !input.topic) return NextResponse.json({ error: "Describe the post topic first." }, { status: 400 });
    const ai = await resolveGeminiConfig(createClient(), session.tenantId);
    if (!ai.apiKey) return NextResponse.json({ error: "AI is not set up yet.", description: "Add a Gemini key in Settings → Integrations, then press Write with AI again.", needsAiKey: true }, { status: 409 });
    let cap: string | null = null;
    /* R-2705: one text per place, each following that platform's strategy (same idea, not the same words). */
    const places = [...new Set(input.platforms?.length ? input.platforms : [input.platform])];
    const strategies = pageId ? await readStrategies(session, pageId).catch(() => null) : null;
    const rules = places.map((p) => strategies ? describePlan(p, planFor(strategies, p).plan) : "").filter(Boolean).join("\n");
    const about = page?.brief ? `This Page (${page.name}) is about: ${page.brief}` : "";
    const result = await geminiJson<{ facebook?: string; instagram?: string }>({ apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId,
      system: `You write honest, useful B2B social media posts. Return JSON with one text per platform asked: {${places.map((p) => `"${p}":"…"`).join(",")}}. Each text follows its platform's strategy — the same idea, NOT the same words. No invented results, testimonials, prices, offers, or customer names. Avoid engagement bait. No links in Instagram text. The post has ONE picture: never say swipe, slides or carousel. This is a draft for human review.`,
      user: input.adapt && input.caption
        ? `Rewrite this post for ${page?.name ?? "this Page"} — same idea, its own words, fitting its business.\n${about}\n${rules}\nPost: ${input.caption}`
        : `Format: ${input.format}. Topic: ${input.topic}.\n${about}\n${rules || "Write a concise, professional caption."}`,
      temperature: 0.5, label: "marketing/social-draft", onCapReached: m => { cap = m; } });
    if (cap) return NextResponse.json({ error: cap }, { status: 429 });
    const captions = Object.fromEntries(places.map((p) => [p, (result?.[p] ?? "").trim().slice(0, 2200)]));
    caption = captions[input.platform] || Object.values(captions).find(Boolean) || (input.adapt ? input.caption : "");
    if (!caption) return NextResponse.json({ error: "AI could not write a draft. Please try again or write it yourself." }, { status: 502 });
    origin = "ai";
    if (input.previewOnly) return NextResponse.json({ caption, captions });
  }
  if (!caption && input.format === "post") return NextResponse.json({ error: "Write a caption." }, { status: 400 });
  /* R-2731: an AI picture kept on another Page's photos is copied to this Page's photos. */
  let mediaUrl = input.mediaUrl;
  if (mediaUrl && pagePhotoId(mediaUrl) && input.mediaPageId && pageId && input.mediaPageId !== pageId) {
    const [from, to] = await Promise.all([pageConnection(admin, session.tenantId, input.mediaPageId), pageConnection(admin, session.tenantId, pageId)]);
    const link = from.pageToken ? (await pagePhotoLinks([mediaUrl], from.pageToken)).get(mediaUrl) : null;
    const img = link ? await fetch(link, { signal: AbortSignal.timeout(20_000) }).catch(() => null) : null;
    if (!img?.ok || !to.pageId || !to.pageToken) return NextResponse.json({ error: `Could not copy the picture to ${page?.name ?? "this Page"}.`, description: "Make a new picture for it, or remove the picture." }, { status: 502 });
    mediaUrl = await uploadPagePhoto(to.pageId, to.pageToken, Buffer.from(await img.arrayBuffer()), img.headers.get("content-type") ?? "image/jpeg");
  }
  try {
    const id = await createSocial(session, { platform: input.platform, format: input.format, caption,
      mediaUrl, topic: input.topic, origin, scheduledAt, pageId,
      /* R-2709: "Schedule post" — a person's own post needs nobody's approval. */
      status: input.submit ? (canReviewSocial(role) ? "approved" : "review") : "draft" });
    await logPersonActivity(session, { pageId, platform: input.platform, action: input.submit ? (scheduledAt ? "Scheduled a post" : "Saved a post to publish by hand") : "Saved a draft", detail: caption.slice(0, 120), contentId: id });
    return NextResponse.json({ id, caption, mediaUrl }, { status: 201 });
  } catch (error) {
    console.error("[social-content] create failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not save the draft." }, { status: 500 });
  }
}
