/**
 * Social content → AI posts settings.
 * PUT  — save: weekly AI posts on/off, what to write about, ask-first or autopilot (R-2672),
 *        posts per week, picture links (Instagram needs a picture). Owner only.
 * POST — "Plan this week now": the AI plans the week straight away (owner or manager).
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
const body = z.object({
  autoDrafts: z.boolean(),
  brief: z.string().trim().max(1000),
  autopilot: z.boolean().default(false),
  postsPerWeek: z.number().int().min(1).max(7).default(3),
  pictures: z.string().max(70_000).default(""),
});

export async function PUT(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (await socialRole(session) !== "owner") return NextResponse.json({ error: "Only the owner can change AI posts.", description: "Ask the owner to save these settings." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings." }, { status: 400 });
  const { autoDrafts, brief, autopilot, postsPerWeek, pictures } = parsed.data;
  if ((autoDrafts || autopilot) && !brief) return NextResponse.json({ error: "Tell the AI what to write about first.", description: "Fill in the box with your products, customers and tone." }, { status: 400 });
  const links = parsePictureLinks(pictures);
  if (links.bad.length) return NextResponse.json({ error: `This picture link is not a public https link: ${links.bad[0].slice(0, 80)}`, description: "Use one https link per line, or remove that line." }, { status: 400 });
  if (pictures.split(/\r?\n/).filter((l) => l.trim()).length > MAX_PICTURES) return NextResponse.json({ error: `Use at most ${MAX_PICTURES} picture links.` }, { status: 400 });
  try {
    const client = createClient();
    const rpc = client.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc.call(client, "set_automation_job", { p_job: "social-drafts", p_enabled: autoDrafts, p_dry_run: false });
    if (error) return NextResponse.json({ error: "Could not turn the weekly AI posts on or off.", description: "Try again in a minute." }, { status: 500 });
    await withTenant(session, tx => tx.$executeRaw`
      insert into public.social_content_settings (tenant_id, auto_drafts, brief, autopilot, posts_per_week, picture_urls, updated_by)
      values (${session.tenantId}::uuid, ${autoDrafts}, ${brief}, ${autopilot}, ${postsPerWeek}, ${links.urls}::text[], ${session.userId}::uuid)
      on conflict (tenant_id) do update set auto_drafts = excluded.auto_drafts, brief = excluded.brief, autopilot = excluded.autopilot,
        posts_per_week = excluded.posts_per_week, picture_urls = excluded.picture_urls,
        updated_by = excluded.updated_by, updated_at = now()`);
    await logPersonActivity(session, { action: "Changed AI settings", detail: !autoDrafts ? "AI posts: off" : autopilot ? `AI posts: autopilot, ${postsPerWeek} a week` : `AI posts: ask me first, ${postsPerWeek} a week` });
    return NextResponse.json({ ok: true, pictures: links.urls.length });
  } catch {
    return NextResponse.json({ error: "Could not save AI posts settings.", description: "Nothing was saved. Try again." }, { status: 500 });
  }
}

export async function POST() {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!canReviewSocial(await socialRole(session))) return NextResponse.json({ error: "Only the owner or a manager can plan the week.", description: "Ask them to press Plan this week now." }, { status: 403 });
  try {
    const result = await planWeek(createAdminClientFor(session.userId), session, { force: true });
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
  const parsed = z.object({ aiPaused: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Stop or Resume." }, { status: 400 });
  const role = await socialRole(session);
  if (!canReviewSocial(role)) return NextResponse.json({ error: "Only the owner or a manager can stop the AI." }, { status: 403 });
  if (!parsed.data.aiPaused && role !== "owner") return NextResponse.json({ error: "Only the owner can resume the AI.", description: "Ask the owner to press Resume AI." }, { status: 403 });
  try {
    await withTenant(session, tx => tx.$executeRaw`
      insert into public.social_content_settings (tenant_id, ai_paused, updated_by)
      values (${session.tenantId}::uuid, ${parsed.data.aiPaused}, ${session.userId}::uuid)
      on conflict (tenant_id) do update set ai_paused = excluded.ai_paused, updated_by = excluded.updated_by, updated_at = now()`);
    await logPersonActivity(session, { action: parsed.data.aiPaused ? "Stopped all AI" : "Resumed AI", detail: parsed.data.aiPaused ? "Nothing the AI planned will be posted until resumed." : "" });
    return NextResponse.json({ ok: true, aiPaused: parsed.data.aiPaused });
  } catch {
    return NextResponse.json({ error: "Could not change the AI switch.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}
