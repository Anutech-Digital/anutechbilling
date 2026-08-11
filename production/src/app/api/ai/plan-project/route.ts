/**
 * POST /api/ai/plan-project
 *
 * Given a project's details, Gemini writes (1) a detailed plain-language
 * explanation of the scope + approach with concrete examples, and (2) a task
 * breakdown to complete it — each task optionally suggested to a team member.
 * Auth required (owner/manager). Falls back to a generic stub without a key.
 *
 * Body: { title, customer?, value?, startDate?, targetDate?, details?, team?: string[] }
 * Returns: { explanation: string, tasks: [{ title, phase?, assignee? }], mode }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  title:      z.string().min(1).max(200),
  customer:   z.string().max(200).optional(),
  value:      z.number().optional(),
  startDate:  z.string().optional(),
  targetDate: z.string().optional(),
  details:    z.string().max(4000).optional(),
  team:       z.array(z.string()).max(50).optional(),
});

export type PlannedTask = { title: string; phase?: string; assignee?: string };
export type ProjectPlan = { explanation: string; tasks: PlannedTask[]; mode: string };

function buildPrompt(b: z.infer<typeof bodySchema>): string {
  const team = (b.team ?? []).filter(Boolean);
  return (
    `You are an experienced delivery/project manager at an Indian IT company. ` +
    `Plan the following client project.\n\n` +
    `PROJECT: ${b.title}\n` +
    (b.customer ? `CLIENT: ${b.customer}\n` : "") +
    (b.value ? `CONTRACT VALUE: ₹${b.value}\n` : "") +
    (b.startDate ? `START: ${b.startDate}\n` : "") +
    (b.targetDate ? `TARGET/DEADLINE: ${b.targetDate}\n` : "") +
    (b.details ? `DETAILS FROM OWNER: ${b.details}\n` : "") +
    (team.length ? `TEAM AVAILABLE (assign tasks to these people by name): ${team.join(", ")}\n` : "") +
    `\nReturn ONLY JSON (no prose, no markdown fences) in this shape:\n` +
    `{ "explanation": "detailed plain-language explanation of the project scope, approach and phases, WITH concrete examples, in simple English (use \\n newlines and '- ' bullets)", ` +
    `"tasks": [ { "title": "short actionable task", "phase": "e.g. Discovery / Design / Build / Test / Delivery", "assignee": "one of the team names above, or empty string if unsure" } ] }\n` +
    `Give 8-15 practical tasks in the real order of delivery. Keep task titles short and doable. ` +
    `If team names are given, distribute tasks sensibly among them.`
  );
}

async function genWithGemini(apiKey: string, model: string, prompt: string): Promise<ProjectPlan | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as { explanation?: unknown; tasks?: unknown };
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((t): t is Record<string, unknown> => !!t && typeof (t as { title?: unknown }).title === "string")
          .slice(0, 25)
          .map((t) => ({
            title: String(t.title).slice(0, 200),
            phase: typeof t.phase === "string" ? String(t.phase).slice(0, 40) : undefined,
            assignee: typeof t.assignee === "string" ? String(t.assignee).slice(0, 120) : undefined,
          }))
      : [];
    if (!explanation && tasks.length === 0) return null;
    return { explanation, tasks, mode: "gemini" };
  } catch (err) {
    console.error("[ai/plan-project] Gemini crashed:", err);
    return null;
  }
}

const STUB = (title: string): ProjectPlan => ({
  explanation:
    `Plan for "${title}" (sample — add a Gemini key in Settings for a tailored plan):\n` +
    `- Discovery: confirm exact requirements + scope with the client, write a short spec.\n` +
    `- Design: finalise architecture / data model / screens.\n` +
    `- Build: implement in milestones, demo each to the client.\n` +
    `- Test: QA, bug-fix, client UAT.\n` +
    `- Delivery: deploy, train the client, handover + go-live.`,
  tasks: [
    { title: "Confirm requirements + write scope doc", phase: "Discovery" },
    { title: "Finalise architecture & data model", phase: "Design" },
    { title: "Set up project + repo + environments", phase: "Build" },
    { title: "Build core modules (milestone 1)", phase: "Build" },
    { title: "Client demo + feedback", phase: "Build" },
    { title: "QA + bug fixing", phase: "Test" },
    { title: "Client UAT sign-off", phase: "Test" },
    { title: "Deploy + train client + handover", phase: "Delivery" },
  ],
  mode: "stub",
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body;
  try { body = bodySchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  if (gemini.apiKey) {
    const plan = await genWithGemini(gemini.apiKey, gemini.model, buildPrompt(body));
    if (plan) return NextResponse.json(plan);
  }
  return NextResponse.json(STUB(body.title));
}
