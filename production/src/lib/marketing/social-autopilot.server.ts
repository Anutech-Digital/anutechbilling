/**
 * R-2672 (G-SOCIAL): the AI plans a week of Facebook / Instagram posts for one company.
 * Used by the Monday cron (social-drafts) and by "Plan this week now" on Social content.
 *
 * - autopilot ON  → each post is saved approved with its time; the social-publish cron posts it.
 * - autopilot OFF → each post waits in "Waiting for approval" with its time; a person approves.
 * Instagram needs a picture: it is planned only when the owner listed pictures; otherwise the
 * result says so (never a post that would fail at its time).
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { createSocial, instagramForPage } from "@/lib/marketing/social-content";
import { planSlots, planStatus, pictureFor } from "@/lib/marketing/social-autopilot";
import type { createAdminClient } from "@/lib/supabase/server";
import { logPersonActivity } from "@/lib/marketing/social-activity";

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
  | { ok: true; created: number; autopilot: boolean; instagramSkipped: boolean; firstAt: Date | null }
  | { ok: false; reason: string; status: number };

export async function planWeek(admin: Admin, session: TenantSession, opts: { force?: boolean; now?: Date } = {}): Promise<PlanResult> {
  const now = opts.now ?? new Date();
  const s = await readAutopilotSettings(session);
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const last = s.last_generated_on ? new Date(s.last_generated_on).toISOString().slice(0, 10) : null;
  if (!opts.force && (!s.auto_drafts || last === today)) return { ok: false, reason: "Weekly AI posts are off, or this week is already planned.", status: 409 };
  if (s.ai_paused) return { ok: false, reason: "The AI is stopped (Stop all AI). Press Resume AI first.", status: 409 };
  if (!s.brief.trim()) return { ok: false, reason: "Tell the AI what to write about first (the box under AI posts), then save.", status: 400 };
  const connection = await readFacebookPage(admin, session.tenantId);
  if (!connection.pageId || !connection.pageToken) return { ok: false, reason: "Connect your Facebook Page first (Marketing Hub → Facebook Page).", status: 409 };
  const ai = await resolveGeminiConfig(admin, session.tenantId);
  if (!ai.apiKey) return { ok: false, reason: "Add an AI key first: Settings → Integrations → Gemini.", status: 409 };
  const instagram = await instagramForPage(connection.pageId, connection.pageToken).catch(() => null);

  const count = Math.max(1, Math.min(7, s.posts_per_week || 3));
  let capMessage: string | null = null;
  const result = await geminiJson<{ posts?: { caption?: string; topic?: string }[] }>({
    apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-autopilot", temperature: 0.7,
    system: "You plan honest, useful B2B social media posts for a cloud services reseller that wants more followers. Return JSON {\"posts\":[{\"topic\":\"…\",\"caption\":\"…\"}]}. Each post has a different angle (a tip, a how-to, a common mistake, a question to the audience, a short checklist, a behind-the-scenes note). No invented results, prices, offers, testimonials or customer names. No engagement bait. Up to 3 relevant hashtags. Under 1200 characters each.",
    user: `Write ${count} posts for Facebook and Instagram. Business guidance: ${s.brief}`,
    onCapReached: (m) => { capMessage = m; },
  });
  if (capMessage) return { ok: false, reason: capMessage, status: 429 };
  const posts = (result?.posts ?? []).map((p) => ({ caption: (p.caption ?? "").trim().slice(0, 2200), topic: (p.topic ?? s.brief).trim().slice(0, 500) })).filter((p) => p.caption).slice(0, count);
  if (posts.length === 0) return { ok: false, reason: "The AI did not return any posts. Press Plan this week now again.", status: 502 };

  const slots = planSlots(now, posts.length);
  const status = planStatus(s.autopilot);
  let created = 0;
  for (const [i, post] of posts.entries()) {
    const picture = pictureFor(s.picture_urls, i);
    const fbId = await createSocial(session, { platform: "facebook", format: "post", caption: post.caption, mediaUrl: picture, topic: post.topic, origin: "scheduled", scheduledAt: slots[i], status });
    created++;
    await logPersonActivity(session, { actor: "ai", platform: "facebook", action: s.autopilot ? "Planned a post (autopilot)" : "Wrote a post for approval", detail: post.topic, contentId: fbId, result: s.autopilot ? "ok" : "waiting" });
    if (instagram && picture) {
      const igId = await createSocial(session, { platform: "instagram", format: "post", caption: post.caption, mediaUrl: picture, topic: post.topic, origin: "scheduled", scheduledAt: slots[i], status });
      created++;
      await logPersonActivity(session, { actor: "ai", platform: "instagram", action: s.autopilot ? "Planned a post (autopilot)" : "Wrote a post for approval", detail: post.topic, contentId: igId, result: s.autopilot ? "ok" : "waiting" });
    }
  }
  await withTenant(session, (tx) => tx.$executeRaw`
    update public.social_content_settings set last_generated_on = ${today}::date where tenant_id = ${session.tenantId}::uuid`);
  return { ok: true, created, autopilot: s.autopilot, instagramSkipped: Boolean(instagram) && s.picture_urls.length === 0, firstAt: slots[0] ?? null };
}
