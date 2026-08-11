/**
 * GET /api/public/assessment/[token]
 *
 * Public (no login) — returns a test for an employee to take: title + questions
 * WITHOUT the correct answers (never expose them to the taker) + the employee
 * list for the name picker. Service-role read scoped by the share token.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { AssessmentQuestion, PublicQuestion } from "@/lib/assessments/grade";

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const admin = createAdminClient();
  const { data: test, error } = await admin
    .from("assessments")
    .select("id, tenant_id, title, topic, questions, status")
    .eq("public_token", params.token)
    .maybeSingle();

  if (error || !test) return NextResponse.json({ error: "Test not found." }, { status: 404 });
  if (test.status !== "active") return NextResponse.json({ error: "This test is closed." }, { status: 410 });

  // Strip correct answers before sending to the (public) taker. Keep the
  // Hinglish versions so a bilingual test can offer a language toggle.
  const questions: PublicQuestion[] = ((test.questions as AssessmentQuestion[]) ?? []).map((q) => ({
    q: q.q, options: q.options,
    ...(q.q_hi ? { q_hi: q.q_hi, options_hi: q.options_hi } : {}),
  }));

  // Employee names for the picker (so results tie to a person).
  const { data: emps } = await admin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", test.tenant_id)
    .eq("is_active", true)
    .order("name");

  return NextResponse.json({
    title: test.title,
    topic: test.topic,
    questions,
    employees: (emps ?? []).map((e) => ({ id: e.id, name: e.name })),
  });
}
