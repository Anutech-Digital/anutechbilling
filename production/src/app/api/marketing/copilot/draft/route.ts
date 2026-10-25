/**
 * POST /api/marketing/copilot/draft — R-1879 (epic R-1874): one sentence → a SAVED draft plan.
 *
 * Body: { prompt } ("Diwali offer on Google Workspace for Delhi SMEs").
 * Who: owner, manager, marketing (same as the co-pilot tables, R-1878). No session → 401 first.
 *
 * How: the AI (geminiJson — the one door, counted against the company's monthly AI cap, R-1877)
 * fills name, product, objective, platforms and audience. Every field is checked against the
 * real lists (plan-draft.ts mergeAiPrefill); a bad one falls back to plain word matching.
 * No AI key / AI failed → word matching alone (mode "stub"). Cap used up → 429, nothing saved.
 * The draft is saved at once (ad_plans + ad_target_groups), so a refresh never loses it.
 *
 * Returns { planId, mode: "ai" | "stub", note?, notes }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { buildPrefillPrompt, guessFromPrompt, mergeAiPrefill, normalizePlan, type ItemOption } from "@/lib/marketing/copilot/plan-draft";
import { activeItems, copilotRoleOk, forbidden, writePlan } from "../plans/plan-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LABEL = "marketing/copilot-draft";

const body = z.object({ prompt: z.string().trim().min(3, "Write a line about the campaign.").max(2000) });

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Write a line about the campaign." }, { status: 400 });
  }
  const prompt = parsed.data.prompt;

  const ctx = await withTenant(session, async (tx) => {
    if (!(await copilotRoleOk(tx, session.userId))) return null;
    return { items: await activeItems(tx, session.tenantId) };
  });
  if (!ctx) return forbidden();
  const items: ItemOption[] = ctx.items;

  const ai = await resolveGeminiConfig(createClient(), session.tenantId);
  let mode: "ai" | "stub" = "stub";
  let note: string | undefined;
  let draft = guessFromPrompt(prompt, items);

  if (ai.apiKey) {
    let capMessage: string | null = null;
    const p = buildPrefillPrompt(prompt, items);
    const raw = await geminiJson<unknown>({
      apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId,
      system: p.system, user: p.user, temperature: 0.2, label: LABEL,
      onCapReached: (m) => { capMessage = m; },
    });
    if (capMessage) return NextResponse.json({ error: capMessage, code: "ai_cap_reached" }, { status: 429 });
    if (raw && typeof raw === "object") {
      mode = "ai";
      draft = mergeAiPrefill(raw, prompt, items);
    } else {
      note = "The AI did not answer this time — the form was filled from your words. Check it below.";
    }
  } else {
    note = "No AI key is set up — the form was filled from your words. Check it below.";
  }

  const { plan, notes, error } = normalizePlan(draft);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const planId = await withTenant(session, (tx) => writePlan(tx, session.tenantId, plan));
  return NextResponse.json({ planId, mode, ...(note ? { note } : {}), notes });
}
