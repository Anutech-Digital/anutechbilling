/**
 * POST /api/marketing/copilot/copy/rewrite — R-1897 "Rewrite this line" (Co-pilot Step 3).
 *
 * Body: { planId, platform, field, current, others[], audience?, language? }
 * The AI writes ONE new line for that field (same limit, same brand voice and language, must not
 * repeat the other lines). The server checks it (copy-prompt.ts checkRewrite): over a hard limit,
 * a repeat, or a ₹ figure nobody gave → 422 with the reason; the screen keeps the old line.
 * Returns { text, length, limit }. Nothing is saved here — the screen puts the line in place and
 * autosaves it like an edit.
 *
 * One AI call through geminiJson (Claude or Gemini via AI_PROVIDER; counted against the company's
 * monthly AI cap, R-1877). No AI key → 503 (a template cannot "rewrite"). Cap used up → 429.
 * Who: owner, manager, marketing of the signed-in company (R-1878 roles).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { geminiJson, resolveGeminiConfig } from "@/lib/ai/gemini";
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import { CHANNEL_SPECS, PLATFORMS, fieldSpec, objectiveFor, type AdPlatform, type CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import {
  COPILOT_COPY_ROLES, COPY_LANGUAGES, buildRewritePrompt, checkRewrite, type CopyBrief, type CopyLanguage,
} from "@/lib/marketing/copilot/copy-prompt";
import { AUDIENCE_KEYS, AUDIENCE_WORDS, type AudienceKey } from "@/lib/marketing/copilot/copy-set";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LABEL = "marketing/copilot-rewrite";

const body = z.object({
  planId: z.string().uuid(),
  platform: z.enum(PLATFORMS as unknown as [AdPlatform, ...AdPlatform[]]),
  field: z.string().regex(/^[a-z_]{1,40}$/),
  current: z.string().trim().min(1).max(2000),
  others: z.array(z.string().max(2000)).max(30).default([]),
  audience: z.enum(AUDIENCE_KEYS as unknown as [AudienceKey, ...AudienceKey[]]).optional(),
  language: z.enum(COPY_LANGUAGES as unknown as [CopyLanguage, ...CopyLanguage[]]).optional(),
});

const planLanguage = (v: string | null | undefined): CopyLanguage | undefined =>
  (COPY_LANGUAGES as readonly string[]).includes(v ?? "") ? (v as CopyLanguage) : undefined;

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the line — something in it is not valid.", detail: parsed.error.issues[0]?.message ?? null }, { status: 400 });
  }
  const b = parsed.data;

  const ctx = await withTenant(session, async (tx) => {
    const me = await tx.public_users.findUnique({ where: { id: session.userId }, select: { role: true, is_active: true } });
    const role = me && me.is_active !== false ? String(me.role) : null;
    /* Role gate (R-732 ratchet): owner / manager / marketing — the same roles as the co-pilot tables' RLS. */
    if (!role || !(COPILOT_COPY_ROLES as readonly string[]).includes(role)) return { kind: "forbidden" as const };
    const plan = await tx.ad_plans.findFirst({
      where: { id: b.planId, tenant_id: session.tenantId },
      select: { tone: true, language: true, objective: true, platforms: true, item_id: true, prompt: true },
    });
    if (!plan) return { kind: "no-plan" as const };
    const tenant = await tx.tenants.findUnique({ where: { id: session.tenantId }, select: { name: true } });
    const item = plan.item_id
      ? await tx.items.findFirst({ where: { id: plan.item_id, tenant_id: session.tenantId }, select: { name: true } })
      : null;
    return { kind: "ok" as const, plan, companyName: tenant?.name ?? "", product: item?.name ?? null };
  });
  if (ctx.kind === "forbidden") {
    return NextResponse.json({ error: "Ad copy is for marketing, the owner and managers.", detail: "Ask the owner to change your role on the Team page." }, { status: 403 });
  }
  if (ctx.kind === "no-plan") return NextResponse.json({ error: "That campaign plan was not found." }, { status: 404 });

  const objective = ctx.plan.objective as CopilotObjective;
  const po = objectiveFor(b.platform, objective);
  const spec = po ? fieldSpec(b.platform, po.format, b.field) : null;
  if (!spec || spec.choices || b.field === "business_name") {
    return NextResponse.json({ error: "This line cannot be rewritten by the AI — edit it yourself." }, { status: 400 });
  }

  const gemini = await resolveGeminiConfig(createClient(), session.tenantId);
  if (!gemini.apiKey) {
    return NextResponse.json({ error: "Rewrite needs the AI, and no AI key is set up. Edit the line yourself." }, { status: 503 });
  }

  const brief: CopyBrief = {
    brand: ctx.companyName || "Our business",
    product: ctx.product,
    objective,
    platforms: [b.platform],
    tone: ctx.plan.tone,
    language: b.language ?? planLanguage(ctx.plan.language) ?? "en",
    brief: ctx.plan.prompt ?? "",
    audience: b.audience ? AUDIENCE_WORDS[b.audience] : undefined,
  };
  const ask = { platformLabel: CHANNEL_SPECS[b.platform].label, field: spec, current: b.current, others: b.others.filter((o) => o.trim()) };
  const prompt = buildRewritePrompt(brief, ask);

  let capMessage: string | null = null;
  const raw = await geminiJson<{ text?: unknown }>({
    apiKey: gemini.apiKey, model: gemini.model, tenantId: session.tenantId,
    system: prompt.system, user: prompt.user, temperature: 0.9, label: LABEL,
    onCapReached: (m) => { capMessage = m; },
  });
  if (capMessage) return NextResponse.json({ error: capMessage, code: "ai_cap_reached" }, { status: 429 });
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "The AI did not answer this time. Try again in a minute." }, { status: 502 });
  }

  /* Rupee figures the person typed (plan prompt + product) — the only new ones a line may carry. */
  const allowedMoney = verifyDraftMoney(`${brief.brief} ${brief.product ?? ""}`, []).found;
  const check = checkRewrite(raw.text, ask, allowedMoney);
  if (!check.ok) return NextResponse.json({ error: `${check.reason} The old line is kept — try again.` }, { status: 422 });
  return NextResponse.json({ text: check.text, length: check.length, limit: spec.max ?? spec.recommended });
}
