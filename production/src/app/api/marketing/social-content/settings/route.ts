/**
 * Social content → AI posts settings — R-2729: per Facebook Page (each Page its own brief and mode);
 * "Stop all AI" stays one switch for the company.
 * PUT  — save one Page's weekly AI posts on/off, what to write about, ask-first or autopilot (R-2672),
 *        posts per week, picture links (Instagram needs a picture). Owner only.
 * POST — "Plan this week now": the AI plans the week straight away (marketing team, owner or manager — R-2709).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { canReviewSocial, socialRole } from "@/lib/marketing/social-content";
import { MAX_PICTURES, parsePictureLinks } from "@/lib/marketing/social-autopilot";
import { planWeek } from "@/lib/marketing/social-autopilot.server";
import { logPersonActivity } from "@/lib/marketing/social-activity";
import { resolvePage } from "@/lib/marketing/social-pages.server";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
const body = z.object({
  autoDrafts: z.boolean(),
  brief: z.string().trim().max(1000),
  autopilot: z.boolean().default(false),
  postsPerWeek: z.number().int().min(1).max(7).default(3),
  pictures: z.string().max(70_000).default(""),
  pageId: z.string().regex(/^\d{1,30}$/).optional(),
});
const PageBody = z.object({ pageId: z.string().regex(/^\d{1,30}$/).optional() });

/** R-2729: the asked Page if it is switched on, else the main Page. */
async function pageFor(session: NonNullable<Awaited<ReturnType<typeof getTenantSession>>>, requested?: string) {
  return resolvePage(createAdminClientFor(session.userId) as unknown as SupabaseClient, session.tenantId, requested ?? null);
}

export async function PUT(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (await socialRole(session) !== "owner") return NextResponse.json({ error: "Only the owner can change AI posts.", description: "Ask the owner to save these settings." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings." }, { status: 400 });
  const { autoDrafts, brief, autopilot, postsPerWeek, pictures } = parsed.data;
  const page = await pageFor(session, parsed.data.pageId);
  if (!page) return NextResponse.json({ error: "Connect a Facebook Page first.", description: "Marketing Hub → Facebook Page." }, { status: 409 });
  if ((autoDrafts || autopilot) && !brief) return NextResponse.json({ error: "Tell the AI what to write about first.", description: "Fill in the box with your products, customers and tone." }, { status: 400 });
  const links = parsePictureLinks(pictures);
  if (links.bad.length) return NextResponse.json({ error: `This picture link is not a public https link: ${links.bad[0].slice(0, 80)}`, description: "Use one https link per line, or remove that line." }, { status: 400 });
  if (pictures.split(/\r?\n/).filter((l) => l.trim()).length > MAX_PICTURES) return NextResponse.json({ error: `Use at most ${MAX_PICTURES} picture links.` }, { status: 400 });
  try {
    const client = createClient();
    const rpc = client.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    await withTenant(session, tx => tx.$executeRaw`
      update public.social_pages set auto_drafts = ${autoDrafts}, brief = ${brief}, autopilot = ${autopilot}, posts_per_week = ${postsPerWeek},
        picture_urls = ${links.urls}::text[], updated_at = now()
      where tenant_id = ${session.tenantId}::uuid and page_id = ${page.page_id}`);
    /* The Monday job runs while any Page wants weekly AI posts. */
    const anyOn = await withTenant(session, tx => tx.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from public.social_pages where tenant_id = ${session.tenantId}::uuid and active and auto_drafts`);
    const { error } = await rpc.call(client, "set_automation_job", { p_job: "social-drafts", p_enabled: Number(anyOn[0]?.n ?? 0) > 0, p_dry_run: false });
    if (error) return NextResponse.json({ error: "Saved, but the weekly AI job could not be switched.", description: "Try saving again in a minute." }, { status: 500 });
    await logPersonActivity(session, { pageId: page.page_id, action: "Changed AI settings", detail: !autoDrafts ? "AI posts: off" : autopilot ? `AI posts: autopilot, ${postsPerWeek} a week` : `AI posts: ask me first, ${postsPerWeek} a week` });
    return NextResponse.json({ ok: true, pictures: links.urls.length });
  } catch {
    return NextResponse.json({ error: "Could not save AI posts settings.", description: "Nothing was saved. Try again." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!canReviewSocial(await socialRole(session))) return NextResponse.json({ error: "Only the marketing team can plan the week.", description: "Ask the owner to give you marketing access." }, { status: 403 });
  const parsed = PageBody.safeParse(await req.json().catch(() => ({})));
  try {
    const page = await pageFor(session, parsed.success ? parsed.data.pageId : undefined);
    if (!page) return NextResponse.json({ error: "Connect a Facebook Page first.", description: "Marketing Hub → Facebook Page." }, { status: 409 });
    const result = await planWeek(createAdminClientFor(session.userId), session, { force: true, pageId: page.page_id });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[social-autopilot] plan failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not plan the week.", description: "Nothing was posted. Try again in a minute." }, { status: 502 });
  }
}

/**
 * R-2687: "Stop all AI" / "Resume AI". Stopping is allowed to the owner and managers (safety
 * first); resuming only to the owner. While stopped nothing the AI planned is published.
 */
export async function PATCH(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const parsed = z.object({ aiPaused: z.boolean().optional(), commentMode: z.enum(["off", "ask", "auto"]).optional(), pageId: z.string().regex(/^\d{1,30}$/).optional() })
    .refine((v) => v.aiPaused !== undefined || v.commentMode !== undefined).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Stop or Resume." }, { status: 400 });
  const role = await socialRole(session);
  /* R-2689: comment replies Off / Ask me first / Autopilot — the marketing team chooses. */
  if (parsed.data.commentMode !== undefined) {
    if (!canReviewSocial(role)) return NextResponse.json({ error: "Only the marketing team can change comment replies." }, { status: 403 });
    try {
      const page = await pageFor(session, parsed.data.pageId);
      if (!page) return NextResponse.json({ error: "Connect a Facebook Page first." }, { status: 409 });
      await withTenant(session, tx => tx.$executeRaw`
        update public.social_pages set comment_mode = ${parsed.data.commentMode}, updated_at = now()
        where tenant_id = ${session.tenantId}::uuid and page_id = ${page.page_id}`);
      await logPersonActivity(session, { pageId: page.page_id, action: "Changed comment replies", detail: parsed.data.commentMode === "off" ? "Comment replies: off" : parsed.data.commentMode === "auto" ? "Comment replies: autopilot (complaints still wait for a person)" : "Comment replies: ask me first" });
      return NextResponse.json({ ok: true, commentMode: parsed.data.commentMode });
    } catch {
      return NextResponse.json({ error: "Could not change comment replies.", description: "Nothing changed. Try again." }, { status: 500 });
    }
  }
  const aiPaused = parsed.data.aiPaused!;
  if (!canReviewSocial(role)) return NextResponse.json({ error: "Only the marketing team can stop the AI." }, { status: 403 });
  if (!aiPaused && role !== "owner") return NextResponse.json({ error: "Only the owner can resume the AI.", description: "Ask the owner to press Resume AI." }, { status: 403 });
  try {
    await withTenant(session, tx => tx.$executeRaw`
      insert into public.social_content_settings (tenant_id, ai_paused, updated_by)
      values (${session.tenantId}::uuid, ${aiPaused}, ${session.userId}::uuid)
      on conflict (tenant_id) do update set ai_paused = excluded.ai_paused, updated_by = excluded.updated_by, updated_at = now()`);
    await logPersonActivity(session, { action: aiPaused ? "Stopped all AI" : "Resumed AI", detail: aiPaused ? "Nothing the AI planned will be posted until resumed." : "" });
    return NextResponse.json({ ok: true, aiPaused });
  } catch {
    return NextResponse.json({ error: "Could not change the AI switch.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}
