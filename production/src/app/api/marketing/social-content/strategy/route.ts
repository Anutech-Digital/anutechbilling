/**
 * /api/marketing/social-content/strategy — R-2705 / R-2707 (G-SOCIAL): each platform's strategy.
 * POST  {}                      — write the first strategy for platforms that have none (AI).
 * PUT   { platform, plan }      — a person changes a strategy → a new active version.
 * PATCH { platform, accept }    — Use it / Keep old on the AI's proposed change.
 * Who: owner or manager (marketing reads them on the page). 401 · 403 · 400 · 404 no proposal · 409 no AI key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { canReviewSocial, socialRole } from "@/lib/marketing/social-content";
import { decideProposal, editStrategy, ensureStrategies } from "@/lib/marketing/social-strategy.server";
import { readAutopilotSettings } from "@/lib/marketing/social-autopilot.server";
import { STRATEGY_PLATFORMS } from "@/lib/marketing/social-strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const Platform = z.enum(STRATEGY_PLATFORMS);

async function lead() {
  const session = await getTenantSession();
  if (!session) return { error: NextResponse.json({ error: "Sign in again." }, { status: 401 }) } as const;
  if (!canReviewSocial(await socialRole(session))) return { error: NextResponse.json({ error: "Only the owner or a manager can change the strategy.", description: "Ask them to change it." }, { status: 403 }) } as const;
  return { session } as const;
}

export async function POST() {
  const r = await lead();
  if ("error" in r) return r.error;
  try {
    const ai = await resolveGeminiConfig(createClient(), r.session.tenantId);
    if (!ai.apiKey) return NextResponse.json({ error: "AI is not set up yet.", description: "Add a Gemini key in Settings → Integrations, then try again." }, { status: 409 });
    const settings = await readAutopilotSettings(r.session);
    if (settings.ai_paused) return NextResponse.json({ error: "The AI is stopped (Stop all AI).", description: "Press Resume AI first." }, { status: 409 });
    await ensureStrategies(r.session, ai, settings.brief);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[social-strategy] start failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not write the strategies.", description: "Nothing changed. Try again in a minute." }, { status: 502 });
  }
}

export async function PUT(req: Request) {
  const r = await lead();
  if ("error" in r) return r.error;
  const parsed = z.object({ platform: Platform, plan: z.record(z.string(), z.unknown()) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a platform and fill in the strategy." }, { status: 400 });
  try {
    const row = await editStrategy(r.session, parsed.data.platform, parsed.data.plan);
    return NextResponse.json({ ok: true, version: row.version });
  } catch (e) {
    console.error("[social-strategy] edit failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not save the strategy.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const r = await lead();
  if ("error" in r) return r.error;
  const parsed = z.object({ platform: Platform, accept: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Use it or Keep old." }, { status: 400 });
  try {
    const done = await decideProposal(r.session, parsed.data.platform, parsed.data.accept);
    if (!done) return NextResponse.json({ error: "There is no suggested change waiting.", description: "Refresh the page." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[social-strategy] decide failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not save your choice.", description: "Nothing changed. Try again." }, { status: 500 });
  }
}
