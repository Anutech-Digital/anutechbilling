import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { readFacebookPage } from "@/lib/integrations/facebook-page";
import { canReviewSocial, canWriteSocial, createSocial, instagramForPage, listSocial, socialRole, validMediaUrl } from "@/lib/marketing/social-content";
import { parseIstLocal, scheduleProblem } from "@/lib/marketing/social-schedule";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const draft = z.object({
  platform: z.enum(["facebook", "instagram"]), format: z.enum(["post", "story"]),
  caption: z.string().trim().max(2200).default(""), mediaUrl: z.string().trim().max(2000).nullable().default(null),
  topic: z.string().trim().max(500).default(""), ai: z.boolean().default(false),
  /* R-2510: post time as typed in the form ("2026-11-06T09:00", India time). */
  scheduledAt: z.string().trim().max(16).nullable().default(null),
  /* R-2513: save and send for approval in one step (status review). */
  submit: z.boolean().default(false),
  /* R-2513: "Write with AI" only fills the caption box — nothing is saved until the person sends it. */
  previewOnly: z.boolean().default(false),
});

export async function GET() {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const role = await socialRole(session);
  if (!canWriteSocial(role)) return NextResponse.json({ error: "Only the marketing team can view social content." }, { status: 403 });
  try {
    const [items, settings, connection] = await Promise.all([
      listSocial(session),
      withTenant(session, tx => tx.$queryRaw<{ auto_drafts: boolean; brief: string }[]>`select auto_drafts, brief from public.social_content_settings where tenant_id = ${session.tenantId}::uuid`),
      readFacebookPage(createAdminClientFor(session.userId), session.tenantId),
    ]);
    const instagram = connection.pageId && connection.pageToken ? await instagramForPage(connection.pageId, connection.pageToken) : null;
    return NextResponse.json({ items, settings: settings[0] ?? { auto_drafts: false, brief: "" },
      canReview: canReviewSocial(role), canManage: role === "owner",
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
  if (!canWriteSocial(await socialRole(session))) return NextResponse.json({ error: "Marketing access required." }, { status: 403 });
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
    if (!ai.apiKey) return NextResponse.json({ error: "Set up an AI key before generating drafts." }, { status: 409 });
    let cap: string | null = null;
    const result = await geminiJson<{ caption?: string }>({ apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId,
      system: "You write honest, useful B2B social media posts for a cloud services reseller. Return JSON with one caption. No invented results, testimonials, prices, offers, or customer names. Avoid engagement bait. Include at most 3 relevant hashtags. This is a draft for human review.",
      user: `Platform: ${input.platform}. Format: ${input.format}. Topic: ${input.topic}. Write a concise, professional caption.`,
      temperature: 0.5, label: "marketing/social-draft", onCapReached: m => { cap = m; } });
    if (cap) return NextResponse.json({ error: cap }, { status: 429 });
    caption = result?.caption?.trim().slice(0, 2200) ?? "";
    if (!caption) return NextResponse.json({ error: "AI could not write a draft. Please try again or write it yourself." }, { status: 502 });
    origin = "ai";
    if (input.previewOnly) return NextResponse.json({ caption });
  }
  if (!caption && input.format === "post") return NextResponse.json({ error: "Write a caption." }, { status: 400 });
  try {
    const id = await createSocial(session, { platform: input.platform, format: input.format, caption,
      mediaUrl: input.mediaUrl, topic: input.topic, origin, scheduledAt, status: input.submit ? "review" : "draft" });
    return NextResponse.json({ id, caption }, { status: 201 });
  } catch (error) {
    console.error("[social-content] create failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not save the draft." }, { status: 500 });
  }
}
