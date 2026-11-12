import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { canReviewSocial, canWriteSocial, createSocial, instagramForPage, listSocial, metaFollowers, pagePhotoLinks, socialRole, validMediaUrl } from "@/lib/marketing/social-content";
import { listActivity, logPersonActivity } from "@/lib/marketing/social-activity";
import { readLinkedInConnection } from "@/lib/integrations/linkedin/store";
import { parseIstLocal, scheduleProblem } from "@/lib/marketing/social-schedule";
import { planFor, readStrategies } from "@/lib/marketing/social-strategy.server";
import { describePlan } from "@/lib/marketing/social-strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
});

export async function GET() {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Only the marketing team can view social content." }, { status: 403 });
  try {
    const [items, settings, connection] = await Promise.all([
      listSocial(session),
      withTenant(session, tx => tx.$queryRaw<{ auto_drafts: boolean; brief: string; autopilot: boolean; posts_per_week: number; picture_urls: string[]; last_generated_on: Date | null; ai_paused: boolean }[]>`select auto_drafts, brief, autopilot, posts_per_week, picture_urls, last_generated_on, ai_paused from public.social_content_settings where tenant_id = ${session.tenantId}::uuid`),
      readFacebookPage(createAdminClientFor(session.userId), session.tenantId),
    ]);
    const instagram = connection.pageId && connection.pageToken ? await instagramForPage(connection.pageId, connection.pageToken) : null;
    // R-2687: the account cards (followers today) and the activity list.
    const [followers, activity, linkedin, photoLinks, strategies] = await Promise.all([
      connection.pageId && connection.pageToken ? metaFollowers(connection.pageId, connection.pageToken, instagram?.id ?? null) : Promise.resolve({ facebook: null, instagram: null }),
      listActivity(session, 60).catch(() => []),
      readLinkedInConnection(createAdminClientFor(session.userId), session.tenantId).catch(() => null),
      // R-2697: AI pictures kept on the Page — today's link to show them.
      connection.pageToken ? pagePhotoLinks(items.map((i) => i.media_url), connection.pageToken) : Promise.resolve(new Map<string, string>()),
      readStrategies(session).catch(() => null), // R-2705
    ]);
    // R-2672: tell the screen up front whether AI can write, so Write with AI never fails silently.
    const aiReady = Boolean((await resolveGeminiConfig(createClient(), session.tenantId)).apiKey);
    return NextResponse.json({ items: items.map((i) => ({ ...i, media_preview: i.media_url ? photoLinks.get(i.media_url) ?? null : null })), settings: settings[0] ?? { auto_drafts: false, brief: "", autopilot: false, posts_per_week: 3, picture_urls: [], last_generated_on: null, ai_paused: false },
      followers, activity, strategies,
      linkedin: linkedin?.organizationUrn ? { name: linkedin.organizationName ?? "LinkedIn Page" } : null,
      canReview: canReviewSocial(role), canManage: role === "owner", aiReady,
      facebook: connection.pageId ? { name: connection.pageName, connected: true } : null,
      instagram: instagram ? { name: instagram.username ?? "Instagram", type: null } : null });
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
  let caption = input.caption;
  let origin: "manual" | "ai" = "manual";
  if (input.ai) {
    if (!input.topic) return NextResponse.json({ error: "Describe the post topic first." }, { status: 400 });
    const ai = await resolveGeminiConfig(createClient(), session.tenantId);
    if (!ai.apiKey) return NextResponse.json({ error: "AI is not set up yet.", description: "Add a Gemini key in Settings → Integrations, then press Write with AI again.", needsAiKey: true }, { status: 409 });
    let cap: string | null = null;
    /* R-2705: one text per place, each following that platform's strategy (same idea, not the same words). */
    const places = [...new Set(input.platforms?.length ? input.platforms : [input.platform])];
    const strategies = await readStrategies(session).catch(() => null);
    const rules = places.map((p) => strategies ? describePlan(p, planFor(strategies, p).plan) : "").filter(Boolean).join("\n");
    const result = await geminiJson<{ facebook?: string; instagram?: string }>({ apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId,
      system: `You write honest, useful B2B social media posts for a cloud services reseller. Return JSON with one text per platform asked: {${places.map((p) => `"${p}":"…"`).join(",")}}. Each text follows its platform's strategy — the same idea, NOT the same words. No invented results, testimonials, prices, offers, or customer names. Avoid engagement bait. No links in Instagram text. The post has ONE picture: never say swipe, slides or carousel. This is a draft for human review.`,
      user: `Format: ${input.format}. Topic: ${input.topic}.\n${rules || "Write a concise, professional caption."}`,
      temperature: 0.5, label: "marketing/social-draft", onCapReached: m => { cap = m; } });
    if (cap) return NextResponse.json({ error: cap }, { status: 429 });
    const captions = Object.fromEntries(places.map((p) => [p, (result?.[p] ?? "").trim().slice(0, 2200)]));
    caption = captions[input.platform] || Object.values(captions).find(Boolean) || "";
    if (!caption) return NextResponse.json({ error: "AI could not write a draft. Please try again or write it yourself." }, { status: 502 });
    origin = "ai";
    if (input.previewOnly) return NextResponse.json({ caption, captions });
  }
  if (!caption && input.format === "post") return NextResponse.json({ error: "Write a caption." }, { status: 400 });
  try {
    const id = await createSocial(session, { platform: input.platform, format: input.format, caption,
      mediaUrl: input.mediaUrl, topic: input.topic, origin, scheduledAt,
      /* R-2709: "Schedule post" — a person's own post needs nobody's approval. */
      status: input.submit ? (canReviewSocial(role) ? "approved" : "review") : "draft" });
    await logPersonActivity(session, { platform: input.platform, action: input.submit ? (scheduledAt ? "Scheduled a post" : "Saved a post to publish by hand") : "Saved a draft", detail: caption.slice(0, 120), contentId: id });
    return NextResponse.json({ id, caption }, { status: 201 });
  } catch (error) {
    console.error("[social-content] create failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not save the draft." }, { status: 500 });
  }
}
