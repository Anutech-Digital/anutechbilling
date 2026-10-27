/**
 * R-1897 — Co-pilot Step 3 data: load the plan's copy sets, autosave one set, ask the AI for a
 * full set or one line, list a set's versions, Mark ready. All through /api/marketing/copilot/*
 * (role-checked on the server, RLS behind it). Nothing here reaches Google or Meta.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { AdPlatform } from "@/lib/marketing/copilot/channel-specs";
import type { CopyLanguage } from "@/lib/marketing/copilot/copy-prompt";
import type { AudienceKey, CopyRow } from "@/lib/marketing/copilot/copy-set";

export interface SavedSetDto { platform: AdPlatform; audience: AudienceKey; format: string; version: number; rows: CopyRow[] }
export interface VersionDto { version: number; savedAt: string; lines: Omit<CopyRow, "platform" | "audience" | "format">[] }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError((body.error as string) ?? `Something went wrong (${res.status}). Try again.`, res.status, body);
  return body as T;
}

export const copyKey = (planId: string) => ["copilot-copy", planId] as const;

export function useCopySets(planId: string) {
  return useQuery({
    queryKey: copyKey(planId),
    queryFn: () => json<{ status: string; sets: SavedSetDto[] }>(`/api/marketing/copilot/plans/${planId}/copy`),
    /* The editor owns the lines once loaded; a background refetch must not overwrite typing. */
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function saveSet(planId: string, body: {
  platform: AdPlatform; audience: AudienceKey; format: string; expectedVersion: number;
  lines: Omit<CopyRow, "platform" | "audience" | "format">[];
}) {
  return json<{ version: number; status: string }>(`/api/marketing/copilot/plans/${planId}/copy`, { method: "PUT", body: JSON.stringify(body) });
}

export interface AiField { platform: string; field: string; lines: { text: string }[]; dropped: { text: string; reason: string }[] }

export function writeCopy(planId: string, platform: AdPlatform, audience: AudienceKey, language: CopyLanguage) {
  return json<{ mode: "ai" | "stub"; note?: string; fields: AiField[]; skipped: { reason: string }[] }>(
    "/api/marketing/copilot/copy",
    { method: "POST", body: JSON.stringify({ planId, platforms: [platform], audience, language }) },
  );
}

export function rewriteLine(body: {
  planId: string; platform: AdPlatform; field: string; current: string; others: string[];
  audience: AudienceKey; language: CopyLanguage;
}) {
  return json<{ text: string; length: number; limit: number | null }>("/api/marketing/copilot/copy/rewrite", { method: "POST", body: JSON.stringify(body) });
}

export function listVersions(planId: string, platform: AdPlatform, audience: AudienceKey) {
  return json<{ versions: VersionDto[] }>(`/api/marketing/copilot/plans/${planId}/copy/versions?platform=${platform}&audience=${audience}`);
}

export function markReady(planId: string) {
  return json<{ status: string }>(`/api/marketing/copilot/plans/${planId}/ready`, { method: "POST" });
}
