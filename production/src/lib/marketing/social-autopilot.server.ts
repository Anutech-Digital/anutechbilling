/**
 * R-2672 (G-SOCIAL): the AI plans a week of Facebook / Instagram posts for one company.
 * Used by the Monday cron (social-drafts) and by "Plan this week now" on Social content.
 *
 * - autopilot ON  → each post is saved approved with its time; the social-publish cron posts it.
 * - autopilot OFF → each post waits in "Waiting for approval" with its time; a person approves.
 * Instagram needs a picture: the owner's picture links are used first; without them the AI makes
 * one per post (R-2697). A post with no picture skips Instagram and the result says so.
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { istToday, utcDateISO } from "@/lib/dates/ist";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { createSocial, instagramForPage } from "@/lib/marketing/social-content";
import { planSlots, planStatus, pictureFor } from "@/lib/marketing/social-autopilot";
import type { createAdminClient } from "@/lib/supabase/server";
import { logPersonActivity } from "@/lib/marketing/social-activity";
import { makePostPicture } from "@/lib/marketing/social-picture.server";
import { refreshPostStats } from "@/lib/marketing/social-stats.server";
import { ensureStrategies, learnStrategies, planFor, readStrategies } from "@/lib/marketing/social-strategy.server";
import { DEFAULT_PLANS, atIstHour, describePlan, pickTypes } from "@/lib/marketing/social-strategy";

type Admin = ReturnType<typeof createAdminClient>;

export interface AutopilotSettings {
  auto_drafts: boolean; brief: string; last_generated_on: Date | string | null;
  autopilot: boolean; posts_per_week: number; picture_urls: string[]; ai_paused: boolean;
}

export async function readAutopilotSettings(session: TenantSession): Promise<AutopilotSettings> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<AutopilotSettings[]>`
    select auto_drafts, brief, last_generated_on, autopilot, posts_per_week, picture_urls, ai_paused
    from public.social_content_settings where tenant_id = ${session.tenantId}::uuid`);
  return rows[0] ?? { auto_drafts: false, brief: "", last_generated_on: null, autopilot: false, posts_per_week: 3, picture_urls: [], ai_paused: false };
}

export type PlanResult =
  | { ok: true; created: number; autopilot: boolean; instagramSkipped: boolean; firstAt: Date | null; aiPictures: number; pictureProblem: string | null;
      resultsRead: number; needsReconnect: boolean; learned: Awaited<ReturnType<typeof learnStrategies>> }
  | { ok: false; reason: string; status: number };

export async function planWeek(admin: Admin, session: TenantSession, opts: { force?: boolean; now?: Date } = {}): Promise<PlanResult> {
  const now = opts.now ?? new Date();
  const s = await readAutopilotSettings(session);
  const today = istToday(now);
  /* a Postgres date comes back as UTC midnight of that day */
  const last = s.last_generated_on ? (typeof s.last_generated_on === "string" ? s.last_generated_on.slice(0, 10) : utcDateISO(s.last_generated_on)) : null;
  if (!opts.force && (!s.auto_drafts || last === today)) return { ok: false, reason: "Weekly AI posts are off, or this week is already planned.", status: 409 };
  if (s.ai_paused) return { ok: false, reason: "The AI is stopped (Stop all AI). Press Resume AI first.", status: 409 };
  if (!s.brief.trim()) return { ok: false, reason: "Tell the AI what to write about first (the box under AI posts), then save.", status: 400 };
  const connection = await readFacebookPage(admin, session.tenantId);
  if (!connection.pageId || !connection.pageToken) return { ok: false, reason: "Connect your Facebook Page first (Marketing Hub → Facebook Page).", status: 409 };
  const ai = await resolveGeminiConfig(admin, session.tenantId);
  if (!ai.apiKey) return { ok: false, reason: "Add an AI key first: Settings → Integrations → Gemini.", status: 409 };
  const instagram = await instagramForPage(connection.pageId, connection.pageToken).catch(() => null);

  /* R-2706: read the results of last weeks' posts first; R-2705/R-2707: start each platform's
     strategy if it has none, then let the AI keep what worked and change what did not. */
  const results = await refreshPostStats(session, connection.pageToken, now).catch(() => ({ read: 0, noPermission: false }));
  let strategies = await ensureStrategies(session, ai, s.brief).catch(() => null);
  const learned = strategies ? await learnStrategies(session, ai, { autopilot: s.autopilot, now }).catch(() => []) : [];
  if (learned.some((l) => l.outcome === "changed")) strategies = await readStrategies(session).catch(() => strategies);
  const fb = strategies ? planFor(strategies, "facebook") : { plan: DEFAULT_PLANS.facebook, version: null };
  const ig = strategies ? planFor(strategies, "instagram") : { plan: DEFAULT_PLANS.instagram, version: null };

  const count = Math.max(1, Math.min(7, s.posts_per_week || 3));
  const types = pickTypes(fb.plan.mix, count);
  let capMessage: string | null = null;
  const result = await geminiJson<{ posts?: { topic?: string; type?: string; facebook?: string; instagram?: string }[] }>({
    apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-autopilot", temperature: 0.7,
    system: "You plan honest, useful B2B social media posts for a cloud services reseller that wants more followers. For each post write one text per platform, each following that platform's strategy (length, tone, hashtags) — the same idea, NOT the same words. Return JSON {\"posts\":[{\"topic\":\"…\",\"type\":\"…\",\"facebook\":\"…\",\"instagram\":\"…\"}]}. No invented results, prices, offers, testimonials or customer names. No engagement bait. No links in Instagram text. Each post has ONE picture: never say swipe, slides or carousel.",
    user: [
      `Write ${count} posts. Kind of each post, in order: ${types.join(", ")}.`,
      describePlan("facebook", fb.plan),
      instagram ? describePlan("instagram", ig.plan) : "No Instagram this week: leave \"instagram\" empty.",
      `Business guidance: ${s.brief}`,
    ].join("\n"),
    onCapReached: (m) => { capMessage = m; },
  });
  if (capMessage) return { ok: false, reason: capMessage, status: 429 };
  const posts = (result?.posts ?? []).map((p, i) => ({
    facebook: (p.facebook ?? "").trim().slice(0, 2200), instagram: (p.instagram ?? "").trim().slice(0, 2200),
    topic: (p.topic ?? s.brief).trim().slice(0, 500), type: types[i] ?? types[0],
  })).filter((p) => p.facebook).slice(0, count);
  if (posts.length === 0) return { ok: false, reason: "The AI did not return any posts. Press Plan this week now again.", status: 502 };

  const slots = planSlots(now, posts.length);
  const status = planStatus(s.autopilot);
  /* R-2697: no picture links from the owner → the AI makes one picture per post (kept on the Page).
     A failed picture never stops the plan: that post goes to Facebook without a picture. */
  const aiPictures = s.picture_urls.length ? [] : await Promise.all(posts.map((p) => makePostPicture(admin, session.tenantId, { topic: p.topic, caption: p.facebook }).catch(() => null)));
  const pictureProblem = aiPictures.find((r) => r && !r.ok);
  let created = 0;
  for (const [i, post] of posts.entries()) {
    const made = aiPictures[i];
    const picture = pictureFor(s.picture_urls, i) ?? (made?.ok ? made.mediaUrl : null);
    /* R-2705: each platform posts at its own best hour on the planned day. */
    const fbId = await createSocial(session, { platform: "facebook", format: "post", caption: post.facebook, mediaUrl: picture, topic: post.topic, origin: "scheduled",
      scheduledAt: atIstHour(slots[i], fb.plan.bestHourIst), status, postType: post.type, strategyVersion: fb.version });
    created++;
    await logPersonActivity(session, { actor: "ai", platform: "facebook", action: s.autopilot ? "Planned a post (autopilot)" : "Wrote a post for approval", detail: `${post.type}: ${post.topic}`, contentId: fbId, result: s.autopilot ? "ok" : "waiting" });
    if (instagram && picture) {
      const igId = await createSocial(session, { platform: "instagram", format: "post", caption: post.instagram || post.facebook, mediaUrl: picture, topic: post.topic, origin: "scheduled",
        scheduledAt: atIstHour(slots[i], ig.plan.bestHourIst), status, postType: post.type, strategyVersion: ig.version });
      created++;
      await logPersonActivity(session, { actor: "ai", platform: "instagram", action: s.autopilot ? "Planned a post (autopilot)" : "Wrote a post for approval", detail: `${post.type}: ${post.topic}`, contentId: igId, result: s.autopilot ? "ok" : "waiting" });
    }
  }
  await withTenant(session, (tx) => tx.$executeRaw`
    update public.social_content_settings set last_generated_on = ${today}::date where tenant_id = ${session.tenantId}::uuid`);
  const pictured = s.picture_urls.length ? posts.length : aiPictures.filter((r) => r?.ok).length;
  return { ok: true, created, autopilot: s.autopilot, instagramSkipped: Boolean(instagram) && pictured < posts.length, firstAt: slots[0] ?? null,
    aiPictures: s.picture_urls.length ? 0 : pictured, pictureProblem: pictureProblem && !pictureProblem.ok ? pictureProblem.message : null,
    resultsRead: results.read, needsReconnect: results.noPermission, learned };
}
