"use client";
/**
 * Cold Calling (R-1663) — TanStack Query hooks over /api/cold-calling/*. The routes do the work
 * through withTenant (RLS); these only fetch, cache and invalidate.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface BolnaAgentOption { id: string; name: string }

export interface ColdCampaign {
  id: string;
  name: string;
  agentId: string;
  agentName: string | null;
  productName: string | null;
  status: "draft" | "running" | "paused" | "done";
  dailyLimit: number;
  windowStart: number;
  windowEnd: number;
  createdAt: string;
  counts: Record<string, number>;
  calledToday: number;
}

export interface ColdContact {
  id: string;
  name: string | null;
  company: string | null;
  city: string | null;
  phone: string;
  status: string;
  attempts: number;
  lastCalledAt: string | null;
  nextAttemptAt: string | null;
  durationSec: number | null;
  summary: string | null;
  transcript: string | null;
  seatsHeard: number | null;
  error: string | null;
  leadId: string | null;
  reasons: string[];
}

/** An API refusal, carrying the route's own "what to do next" line. */
export class ColdCallError extends Error {
  constructor(message: string, readonly detail: string | null, readonly status: number) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ColdCallError(
      typeof body.error === "string" ? body.error : "Something went wrong.",
      typeof body.detail === "string" ? body.detail : null,
      res.status,
    );
  }
  return body as T;
}

const KEY = ["cold-calling"] as const;

export function useBolnaAgents() {
  return useQuery({
    queryKey: [...KEY, "agents"],
    queryFn: () => api<{ agents: BolnaAgentOption[]; defaultAgentId: string }>("/api/cold-calling/agents"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useColdProducts() {
  return useQuery({
    queryKey: [...KEY, "products"],
    queryFn: async () => (await api<{ products: { id: string; name: string }[] }>("/api/cold-calling/products")).products,
    staleTime: 5 * 60_000,
  });
}

export function useColdCampaigns() {
  return useQuery({
    queryKey: [...KEY, "campaigns"],
    queryFn: async () => (await api<{ campaigns: ColdCampaign[] }>("/api/cold-calling/campaigns")).campaigns,
    refetchInterval: 30_000,
  });
}

export function useColdContacts(campaignId: string | null, status: string | null) {
  return useQuery({
    queryKey: [...KEY, "contacts", campaignId, status],
    enabled: !!campaignId,
    queryFn: async () => (await api<{ contacts: ColdContact[] }>(
      `/api/cold-calling/campaigns/${campaignId}/contacts${status ? `?status=${status}` : ""}`,
    )).contacts,
    refetchInterval: 30_000,
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; agentId: string; dailyLimit: number; productItemId: string | null }) =>
      api<{ id: string }>("/api/cold-calling/campaigns", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: "running" | "paused" | "done"; dailyLimit?: number }) =>
      api<{ ok: true }>(`/api/cold-calling/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface SkippedNumber {
  phone: string; name: string | null; company?: string | null; city?: string | null; reason: string; leadId?: string | null;
}

export interface ImportResult {
  added: number; alreadyOnList: number; dnd: number; invalidLines: number[]; invalidCount: number; duplicatesInFile: number;
  alreadyCalled: SkippedNumber[]; alreadyCalledCount: number;
  alreadyInSales: SkippedNumber[]; alreadyInSalesCount: number;
}

export function useImportList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, csv, force }: { id: string; csv: string; force?: string[] }) =>
      api<ImportResult>(`/api/cold-calling/campaigns/${id}/import`, { method: "POST", body: JSON.stringify({ csv, force }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface TickResult { checked: number; finished: number; placed: number; failed: number; note: string | null }

export function useTick() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<TickResult>(`/api/cold-calling/campaigns/${id}/tick`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => api<{ ok: true }>(`/api/cold-calling/contacts/${contactId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMoveToPipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) =>
      api<{ leadId: string; joined: boolean; followUpAt: string }>(`/api/cold-calling/contacts/${contactId}/move`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
