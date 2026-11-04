/**
 * POST /api/marketing/neo/ask — R-2165 (G-ADS-AI, AI-09): ask Neo a marketing numbers question.
 * Body: { question } (1–500 characters).
 *
 * question → typed plan (rules first, then the capped AI door) → public.marketing_metrics_query
 * (allowlisted, read-only, RLS) → summary + chart JSON + table. Neo never writes SQL.
 *
 * 401 no session · 400 bad body / nothing to ask · 403 not owner or marketing ·
 * 429 the company's monthly AI cap is used up · 200 { reply }.
 * Same people as the marketing agent (owner, marketing — R-2157); the database function
 * checks the role again, and hides money from a role that cannot read payments.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { istToday } from "@/lib/dates/ist";
import { createClient } from "@/lib/supabase/server";
import { NEO_QUESTION_MAX, NeoError, askNeo } from "@/lib/marketing/neo/graph";
import { neoAiPlanner } from "@/lib/marketing/neo/brain";
import { neoQueryFor } from "@/lib/marketing/neo/query.server";
import { NEO_ROLES } from "@/lib/marketing/neo/plan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  question: z.string().trim().min(1, "Type a question first.").max(NEO_QUESTION_MAX, `Keep the question under ${NEO_QUESTION_MAX} characters.`),
}).strict();

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Type a question first." }, { status: 400 });

  const role = await withTenant(session, async (tx) => {
    const me = await tx.public_users.findUnique({ where: { id: session.userId }, select: { role: true, is_active: true } });
    return me && me.is_active !== false ? String(me.role) : null;
  });
  if (!role || !NEO_ROLES.includes(role)) {
    return NextResponse.json(
      { error: "Neo is for the owner and the marketing team.", detail: "Ask the owner to change your role on the Team page." },
      { status: 403 },
    );
  }

  let capMessage: string | null = null;
  try {
    const ai = await resolveGeminiConfig(createClient(), session.tenantId);
    const today = istToday();
    const reply = await askNeo(parsed.data.question, {
      today: () => today,
      runQuery: neoQueryFor(session),
      aiPlan: neoAiPlanner({
        tenantId: session.tenantId, apiKey: ai.apiKey, model: ai.model, today,
        onCapReached: (m) => { capMessage = m; },
      }),
    });
    return NextResponse.json({ reply });
  } catch (e) {
    if (capMessage) return NextResponse.json({ error: capMessage }, { status: 429 });
    if (e instanceof NeoError) return NextResponse.json({ error: e.message }, { status: e.status });
    const ref = Math.random().toString(36).slice(2, 10);
    console.error(`[api/marketing/neo/ask] failed (${ref}):`, e);
    return NextResponse.json({ error: "Neo could not answer just now. Try again.", ref }, { status: 500 });
  }
}
