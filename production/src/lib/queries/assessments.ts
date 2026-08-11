/**
 * Assessments — owner-side hooks for reasoning tests. Create (AI-generated
 * questions), list, view attempts, delete. Public take/submit go through the
 * /api/public/assessment routes.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { AssessmentRow, AssessmentAttemptRow } from "@/lib/supabase/database.types";
import type { AssessmentQuestion } from "@/lib/assessments/grade";

export type Assessment = Omit<AssessmentRow, "questions"> & { questions: AssessmentQuestion[]; attempts: number };

export function useAssessments() {
  return useQuery({
    queryKey: ["assessments"],
    queryFn: async (): Promise<Assessment[]> => {
      const supabase = createClient();
      const [{ data, error }, { data: attempts }] = await Promise.all([
        supabase.from("assessments").select("*").order("created_at", { ascending: false }),
        supabase.from("assessment_attempts").select("assessment_id"),
      ]);
      if (error) throw error;
      const countByTest = new Map<string, number>();
      for (const a of (attempts ?? []) as { assessment_id: string }[]) countByTest.set(a.assessment_id, (countByTest.get(a.assessment_id) ?? 0) + 1);
      return (data ?? []).map((r) => ({
        ...(r as AssessmentRow),
        questions: ((r as AssessmentRow).questions as AssessmentQuestion[]) ?? [],
        attempts: countByTest.get((r as AssessmentRow).id) ?? 0,
      }));
    },
  });
}

/** Ask the AI (or stub) for reasoning MCQs. */
export async function generateQuestions(input: { topic?: string; difficulty?: string; count?: number; language?: "en" | "hi" | "both"; subject?: "reasoning" | "software" }): Promise<{ questions: AssessmentQuestion[]; mode: string }> {
  const res = await fetch("/api/ai/generate-assessment", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Couldn't generate questions.");
  return json as { questions: AssessmentQuestion[]; mode: string };
}

export function useCreateAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; topic?: string; difficulty?: string; questions: AssessmentQuestion[]; pass_pct?: number }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth!.user!.id).single();
      const token = (globalThis.crypto?.randomUUID?.() ?? `${Math.abs(Date.now())}`).replace(/-/g, "").slice(0, 22);
      const { data, error } = await supabase.from("assessments").insert({
        tenant_id: me!.tenant_id,
        title: input.title.trim(),
        topic: input.topic?.trim() || null,
        difficulty: input.difficulty ?? "medium",
        questions: input.questions,
        pass_pct: input.pass_pct ?? 40,
        public_token: token,
        created_by: auth!.user!.id,
      }).select("public_token").single();
      if (error) throw error;
      return data.public_token as string;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assessments"] }); toast.success("Test created — share the link with your team."); },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useAssessmentAttempts(assessmentId: string | null) {
  return useQuery({
    queryKey: ["assessment_attempts", assessmentId],
    enabled: !!assessmentId,
    queryFn: async (): Promise<AssessmentAttemptRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("assessment_attempts").select("*")
        .eq("assessment_id", assessmentId!).order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AssessmentAttemptRow[];
    },
  });
}

export function useDeleteAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("assessments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assessments"] }); toast.success("Test deleted"); },
    onError: (err) => toast.error((err as Error).message),
  });
}
