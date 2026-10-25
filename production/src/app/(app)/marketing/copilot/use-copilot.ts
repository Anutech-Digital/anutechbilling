/**
 * R-1879 — the co-pilot page's data: Recent plans + product list, one plan, create from a
 * prompt, save steps 1–2. All through /api/marketing/copilot/* (role-checked on the server).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanDraft } from "@/lib/marketing/copilot/plan-draft";

export interface RecentPlan {
  id: string; name: string; objective: string; platforms: string[]; status: string;
  updatedAt: string; product: string | null;
}
export interface SavedPlan extends PlanDraft { id: string; status: string; updatedAt: string }

const KEY = ["copilot-plans"] as const;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Something went wrong (${res.status}). Try again.`);
  return body as T;
}

export function useCopilotHome() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => json<{ plans: RecentPlan[]; items: { id: string; name: string }[]; brand: string }>("/api/marketing/copilot/plans"),
  });
}

export function useCopilotPlan(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    enabled: !!id,
    queryFn: () => json<{ plan: SavedPlan }>(`/api/marketing/copilot/plans/${id}`).then((r) => r.plan),
  });
}

export function useCreateFromPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prompt: string) => json<{ planId: string; mode: "ai" | "stub"; note?: string; notes: string[] }>(
      "/api/marketing/copilot/draft", { method: "POST", body: JSON.stringify({ prompt }) },
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSavePlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: PlanDraft) => json<{ plan: SavedPlan; notes: string[] }>(
      `/api/marketing/copilot/plans/${id}`, { method: "PUT", body: JSON.stringify(plan) },
    ),
    onSuccess: (r) => {
      qc.setQueryData([...KEY, id], r.plan);
      void qc.invalidateQueries({ queryKey: KEY, exact: true });
    },
  });
}
