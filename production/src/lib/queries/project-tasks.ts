/**
 * Project task roadmap + AI project planner — TanStack Query hooks.
 *
 * R-331 (7 Oct 2026): split out of ./projects.ts, which had grown past the 800-line
 * max-lines ratchet. ./projects.ts re-exports everything here, so every existing
 * import from "@/lib/queries/projects" keeps working unchanged.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { ProjectTaskRow, ProjectTaskStatus } from "@/lib/supabase/database.types";

// ── Project task roadmap (migration 0214) ────────────────────────────────────
// Tasks per project, assignable to the project's allocated employees (labour).
export function useProjectTasks(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_tasks", projectId],
    enabled:  Boolean(projectId),
    queryFn: async (): Promise<ProjectTaskRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("project_tasks").select("*").eq("project_id", projectId!)
        .order("seq", { ascending: true }).order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ProjectTaskRow[];
    },
  });
}

export function useCreateProjectTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; title: string; assigneeId?: string | null; dueDate?: string | null; seq?: number }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");
      const { error } = await supabase.from("project_tasks").insert({
        tenant_id:            me.tenant_id,
        project_id:           input.projectId,
        title:                input.title.trim(),
        assignee_employee_id: input.assigneeId ?? null,
        due_date:             input.dueDate ?? null,
        seq:                  input.seq ?? 0,
        created_by:           authData.user.id,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["project_tasks", v.projectId] }); },
    onError: (e) => toastError(e),
  });
}

export function useUpdateProjectTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; projectId: string; patch: { title?: string; status?: ProjectTaskStatus; assignee_employee_id?: string | null; due_date?: string | null; seq?: number } }) => {
      const supabase = createClient();
      const { error } = await supabase.from("project_tasks")
        .update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["project_tasks", v.projectId] }); },
    onError: (e) => toastError(e),
  });
}

export function useDeleteProjectTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; projectId: string }) => {
      const supabase = createClient();
      const { error } = await supabase.from("project_tasks").delete().eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["project_tasks", v.projectId] }); toast.success("Task removed"); },
    onError: (e) => toastError(e),
  });
}

/** AI project planner — returns a detailed explanation + a suggested task list. */
export type PlannedTask = { title: string; phase?: string; assignee?: string };
export type QuestionOption = { labelEn: string; labelHi: string };
export type QuestionItem = { en: string; hi: string; options?: QuestionOption[] };
export type ProjectPlan = {
  explanation: string;
  clientProposal?: string;
  tasks: PlannedTask[];
  questions?: QuestionItem[];
  mode: string;
};

export async function fetchProjectQuestions(input: {
  title: string; customer?: string; details?: string;
}): Promise<QuestionItem[]> {
  const res = await fetch("/api/ai/plan-project", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "questions",
      title: input.title, customer: input.customer, details: input.details,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Could not generate questions.");
  return json.questions ?? [];
}

export async function generateProjectPlan(input: {
  title: string; customer?: string; value?: number; startDate?: string | null; targetDate?: string | null; details?: string; qaAnswers?: string; team?: string[];
}): Promise<ProjectPlan> {
  const res = await fetch("/api/ai/plan-project", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "plan",
      title: input.title, customer: input.customer, value: input.value,
      startDate: input.startDate ?? undefined, targetDate: input.targetDate ?? undefined,
      details: input.details, qaAnswers: input.qaAnswers, team: input.team,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Could not generate the plan.");
  return json as ProjectPlan;
}

/** Bulk-create tasks (from the AI plan), appended after existing ones. */
export function useCreateProjectTasksBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; tasks: { title: string; assigneeId?: string | null }[]; startSeq?: number }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");
      const base = input.startSeq ?? 0;
      const rows = input.tasks
        .filter((t) => t.title.trim())
        .map((t, i) => ({
          tenant_id: me.tenant_id, project_id: input.projectId,
          title: t.title.trim(), assignee_employee_id: t.assigneeId ?? null,
          seq: base + i, created_by: authData.user.id,
        }));
      if (rows.length === 0) return 0;
      const { error } = await supabase.from("project_tasks").insert(rows);
      if (error) throw error;
      return rows.length;
    },
    onSuccess: (n, v) => { qc.invalidateQueries({ queryKey: ["project_tasks", v.projectId] }); toast.success(`${n} tasks added to the roadmap`); },
    onError: (e) => toastError(e),
  });
}

