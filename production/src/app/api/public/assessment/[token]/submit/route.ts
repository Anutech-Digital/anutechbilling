/**
 * POST /api/public/assessment/[token]/submit
 *
 * Public (no login) — an employee submits their answers. Grading happens
 * SERVER-side against the stored correct answers (never trust the client), the
 * attempt is recorded, and the score + grade are returned.
 *
 * Body: { candidate_name: string, employee_id?: string, answers: number[] }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { scoreAttempt, type AssessmentQuestion } from "@/lib/assessments/grade";

const bodySchema = z.object({
  candidate_name: z.string().min(1).max(120),
  employee_id: z.string().uuid().optional().nullable(),
  answers: z.array(z.number().int()).max(50),
  // Lightweight proctoring signals (all optional; clamped to sane bounds).
  duration_seconds: z.number().int().min(0).max(86400).optional(),
  focus_lost_count: z.number().int().min(0).max(10000).optional(),
  focus_lost_seconds: z.number().int().min(0).max(86400).optional(),
  paste_count: z.number().int().min(0).max(10000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  let body;
  try { body = bodySchema.parse(await req.json()); }
  catch { return NextResponse.json({ error: "Invalid submission." }, { status: 400 }); }

  const admin = createAdminClient();
  const { data: test, error } = await admin
    .from("assessments")
    .select("id, tenant_id, questions, status")
    .eq("public_token", params.token)
    .maybeSingle();
  if (error || !test) return NextResponse.json({ error: "Test not found." }, { status: 404 });
  if (test.status !== "active") return NextResponse.json({ error: "This test is closed." }, { status: 410 });

  const questions = (test.questions as AssessmentQuestion[]) ?? [];
  const { score, total, pct, grade } = scoreAttempt(questions, body.answers);

  const { error: insErr } = await admin.from("assessment_attempts").insert({
    tenant_id: test.tenant_id,
    assessment_id: test.id,
    employee_id: body.employee_id ?? null,
    candidate_name: body.candidate_name.trim(),
    answers: body.answers,
    score, total, pct, grade,
    duration_seconds: body.duration_seconds ?? null,
    focus_lost_count: body.focus_lost_count ?? 0,
    focus_lost_seconds: body.focus_lost_seconds ?? 0,
    paste_count: body.paste_count ?? 0,
  });
  if (insErr) return NextResponse.json({ error: "Couldn't save your result. Try again." }, { status: 500 });

  return NextResponse.json({ score, total, pct, grade });
}
