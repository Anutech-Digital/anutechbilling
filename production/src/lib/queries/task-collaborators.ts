/**
 * R-2933 — who works WITH each task's owner (public.task_collaborators), for the Tasks list and
 * the Add / Edit task dialog. One small read for the whole company (RLS: own tenant), kept apart
 * from the tasks read on purpose: if it fails, the Tasks page still lists every task.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export const TASK_COLLABORATORS_KEY = ["task-collaborators"] as const;

/** task id → the user ids working with its owner. */
export type TaskCollaboratorMap = ReadonlyMap<string, readonly string[]>;

export function collaboratorMap(rows: readonly { task_id: string; user_id: string }[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const list = m.get(r.task_id);
    if (list) list.push(r.user_id);
    else m.set(r.task_id, [r.user_id]);
  }
  return m;
}

export function useTaskCollaborators(tenantId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...TASK_COLLABORATORS_KEY, tenantId],
    enabled: (opts.enabled ?? true) && !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const { data, error } = await createClient()
        .from("task_collaborators").select("task_id, user_id").eq("tenant_id", tenantId!).order("created_at", { ascending: true });
      if (error) throw error;
      return collaboratorMap(data ?? []);
    },
  });
}

/** Save the list for one task (POST /api/tasks/collaborators). Answers the server's own words on a refusal. */
export function useSetTaskCollaborators() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { taskId: string; userIds: string[] }): Promise<{ ok: boolean; message?: string }> => {
      const res = await fetch("/api/tasks/collaborators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && body?.ok) return { ok: true };
      return { ok: false, message: body?.error };
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: TASK_COLLABORATORS_KEY }); },
  });
}
