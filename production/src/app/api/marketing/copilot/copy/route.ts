/**
 * POST /api/marketing/copilot/copy — R-1876 (epic R-1874): AI ad copy for each chosen channel,
 * inside that channel's limits.
 *
 * Who: owner, manager, marketing of the signed-in company (same roles as the co-pilot tables,
 * R-1878). Fail-closed: no company on the session → 401, before anything else runs.
 *
 * Body (all optional when `planId` gives them):
 *   { planId?, brand?, itemId?, product?, objective?, platforms?, tone?, language?, brief?, audience? }
 *   audience (R-1897) = which copy set: "generic" (Main audience) or "lookalike".
 *   brand voice = tone + language: the request's, else the plan's (ad_plans), else the default.
 *   brand = the request's, else the company name. product = the request's, else the item's name.
 *
 * How: one AI call through geminiJson (the one door — Claude or Gemini, counted against the
 * company's monthly AI cap, R-1877). Every line is then checked HERE (copy-prompt.ts):
 * over-limit lines go back to the AI once to shorten; still over a hard limit → dropped with the
 * reason, never shown as valid. Meta publishes only recommended lengths — such lines are kept
 * with ok = false. No AI key → template copy (mode "stub"). Cap used up → 429.
 *
 * Returns { mode: "ai" | "stub", note?, brand, tone, language, objective, fields: FieldResult[], skipped }.
 * Nothing is saved — the wizard (R-1879/R-1880) saves what the person keeps into ad_copies.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import { COPILOT_OBJECTIVES, PLATFORMS, type AdPlatform, type CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import {
  COPY_LANGUAGES, SHORTEN_SYSTEM, applyShortened, buildCopyPrompt, buildShortenPrompt, collectCandidates,
  COPILOT_COPY_ROLES, copySlots, finalizeCopy, needsShortening, stubCopy, type CopyBrief, type CopyLanguage,
} from "@/lib/marketing/copilot/copy-prompt";
import { AUDIENCE_KEYS, AUDIENCE_WORDS, type AudienceKey } from "@/lib/marketing/copilot/copy-set";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LABEL = "marketing/copilot-copy";

const body = z.object({
  planId: z.string().uuid().optional(),
  brand: z.string().trim().max(80).optional(),
  itemId: z.string().trim().min(1).max(100).optional(),
  product: z.string().trim().max(120).optional(),
  objective: z.enum(COPILOT_OBJECTIVES as unknown as [CopilotObjective, ...CopilotObjective[]]).optional(),
  platforms: z.array(z.enum(PLATFORMS as unknown as [AdPlatform, ...AdPlatform[]])).max(PLATFORMS.length).optional(),
  tone: z.string().trim().max(200).optional(),
  language: z.enum(COPY_LANGUAGES as unknown as [CopyLanguage, ...CopyLanguage[]]).optional(),
  brief: z.string().trim().max(2000).optional(),
  /* R-1897: the copy set is for one audience (Main / People like my customers). */
  audience: z.enum(AUDIENCE_KEYS as unknown as [AudienceKey, ...AudienceKey[]]).optional(),
});

const planLanguage = (v: string | null | undefined): CopyLanguage | undefined =>
  (COPY_LANGUAGES as readonly string[]).includes(v ?? "") ? (v as CopyLanguage) : undefined;

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the form — something in it is not valid.", detail: parsed.error.issues[0]?.message ?? null }, { status: 400 });
  }
  const b = parsed.data;

  const ctx = await withTenant(session, async (tx) => {
    const me = await tx.public_users.findUnique({ where: { id: session.userId }, select: { role: true, is_active: true } });
    const role = me && me.is_active !== false ? String(me.role) : null;
    /* Role gate (R-732 ratchet): owner / manager / marketing — the same roles as the co-pilot tables' RLS. */
    if (!role || !(COPILOT_COPY_ROLES as readonly string[]).includes(role)) return { kind: "forbidden" as const };
    const tenant = await tx.tenants.findUnique({ where: { id: session.tenantId }, select: { name: true } });
    const plan = b.planId
      ? await tx.ad_plans.findFirst({
          where: { id: b.planId, tenant_id: session.tenantId },
          select: { tone: true, language: true, objective: true, platforms: true, item_id: true },
        })
      : null;
    if (b.planId && !plan) return { kind: "no-plan" as const };
    const itemId = b.itemId ?? plan?.item_id ?? null;
    const item = itemId
      ? await tx.items.findFirst({ where: { id: itemId, tenant_id: session.tenantId }, select: { name: true } })
      : null;
    if (b.itemId && !item) return { kind: "no-item" as const };
    return { kind: "ok" as const, companyName: tenant?.name ?? "", plan, item };
  });

  if (ctx.kind === "forbidden") {
    return NextResponse.json({ error: "Ad copy is for marketing, the owner and managers.", detail: "Ask the owner to change your role on the Team page." }, { status: 403 });
  }
  if (ctx.kind === "no-plan") return NextResponse.json({ error: "That campaign plan was not found." }, { status: 404 });
  if (ctx.kind === "no-item") return NextResponse.json({ error: "That product was not found." }, { status: 404 });

  const objective = (b.objective ?? ctx.plan?.objective) as CopilotObjective | undefined;
  const platforms = (b.platforms ?? ctx.plan?.platforms ?? []).filter((p): p is AdPlatform => (PLATFORMS as readonly string[]).includes(p));
  if (!objective || !(COPILOT_OBJECTIVES as readonly string[]).includes(objective)) {
    return NextResponse.json({ error: "Pick what the campaign is for (the objective)." }, { status: 400 });
  }
  if (!platforms.length) return NextResponse.json({ error: "Tick at least one channel — Google Ads or Meta." }, { status: 400 });

  const brief: CopyBrief = {
    brand: b.brand || ctx.companyName || "Our business",
    product: b.product || ctx.item?.name || null,
    objective,
    platforms: [...new Set(platforms)],
    tone: b.tone || ctx.plan?.tone || null,
    language: b.language ?? planLanguage(ctx.plan?.language) ?? "en",
    brief: b.brief ?? "",
    audience: b.audience ? AUDIENCE_WORDS[b.audience] : undefined,
  };

  const { slots, skipped } = copySlots(brief.platforms, objective);
  if (!slots.length) {
    return NextResponse.json({ error: skipped[0]?.reason ?? "No channel has an ad format for this objective yet.", skipped }, { status: 400 });
  }

  /* Rupee figures the person typed — the only ones the copy may carry (money guard). */
  const allowedMoney = verifyDraftMoney(`${brief.brief} ${brief.product ?? ""}`, []).found;

  const gemini = await resolveGeminiConfig(createClient(), session.tenantId);
  let mode: "ai" | "stub" = "stub";
  let note: string | undefined;
  let raw: unknown = null;
  let capMessage: string | null = null;

  if (gemini.apiKey) {
    const prompt = buildCopyPrompt(brief, slots);
    raw = await geminiJson<unknown>({
      apiKey: gemini.apiKey, model: gemini.model, tenantId: session.tenantId,
      system: prompt.system, user: prompt.user, temperature: 0.8, label: LABEL,
      onCapReached: (m) => { capMessage = m; },
    });
    if (capMessage) return NextResponse.json({ error: capMessage, code: "ai_cap_reached" }, { status: 429 });
    if (raw && typeof raw === "object") mode = "ai";
    else note = "The AI did not answer this time — these are template lines. Try again in a minute.";
  } else {
    note = "No AI key is set up — these are template lines.";
  }

  let candidates = collectCandidates(mode === "ai" ? raw : stubCopy(brief, slots), slots, brief);

  /* One "shorten" retry for lines over a limit. If it is refused or fails, finalizeCopy drops them. */
  const tooLong = needsShortening(candidates, slots);
  if (mode === "ai" && tooLong.length && gemini.apiKey) {
    const fixed = await geminiJson<{ items?: unknown }>({
      apiKey: gemini.apiKey, model: gemini.model, tenantId: session.tenantId,
      system: SHORTEN_SYSTEM, user: buildShortenPrompt(tooLong), temperature: 0.3, label: LABEL,
    });
    if (fixed && Array.isArray(fixed.items)) candidates = applyShortened(candidates, fixed.items);
  }

  const fields = finalizeCopy(candidates, slots, allowedMoney);
  return NextResponse.json({
    mode, ...(note ? { note } : {}),
    brand: brief.brand, tone: brief.tone, language: brief.language, objective,
    fields, skipped,
  });
}
