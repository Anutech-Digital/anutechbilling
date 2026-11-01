"use client";
/**
 * R-2042 — the lead's AI Lead Workflow status as a small badge on list rows and board cards.
 *
 * `leads.ai_status` (R-2039) follows the lead's latest `lead_ai_runs` step. list_leads() returns
 * a fixed slim column list (LEAD_LIST_COLUMNS, pinned to the SQL by two copy tests), so instead of
 * re-creating that function for one badge, the list and the board read the statuses of the rows
 * they show in ONE small query — id + ai_status, only rows that have one — through the caller's
 * own client (RLS decides, exactly as for the rows themselves).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";

/** Every step a run can be at → the badge text. Unknown values render nothing. */
export const AI_STATUS_LABEL: Record<string, string> = {
  fetching: "AI: Running",
  qualified: "AI: Qualified",
  unqualified: "AI: Not qualified",
  draft_ready: "AI: Draft ready",
  sent: "AI: Sent",
  call_scheduled: "AI: Call scheduled",
  call_done: "AI: Call done",
  failed: "AI: Stopped",
};

const AI_STATUS_KIND: Record<string, "muted" | "success" | "warning" | "danger" | "info"> = {
  fetching: "info",
  qualified: "success",
  unqualified: "muted",
  draft_ready: "warning",
  sent: "info",
  call_scheduled: "info",
  call_done: "success",
  failed: "danger",
};

const AI_STATUS_HINT: Record<string, string> = {
  fetching: "The AI Lead Workflow is running on this lead.",
  qualified: "The AI qualified this lead.",
  unqualified: "The AI did not qualify this lead — open it to see why.",
  draft_ready: "An AI email draft is waiting for your approval — nothing has been sent.",
  sent: "The AI email draft was approved and sent.",
  call_scheduled: "An AI call is scheduled.",
  call_done: "The AI call is done — see the Activity tab.",
  failed: "The AI Lead Workflow stopped — open the lead to see what went wrong and the next step.",
};

export function LeadAiStatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status || !AI_STATUS_LABEL[status]) return null;
  return (
    <Badge kind={AI_STATUS_KIND[status]} size="sm" title={AI_STATUS_HINT[status]} className={className}>
      {AI_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Prefix of every statuses query — the drawer invalidates it after a run. */
export const LEAD_AI_STATUSES_KEY = ["lead-ai-statuses"] as const;

/**
 * ai_status for the given lead ids (only those that have one). One request for the whole page
 * of rows; ids are sorted so the same set reuses the cache.
 */
export function useLeadAiStatuses(ids: readonly string[]): Map<string, string> {
  const sorted = React.useMemo(() => [...new Set(ids)].sort(), [ids]);
  const { data } = useQuery({
    queryKey: [...LEAD_AI_STATUSES_KEY, sorted.join(",")],
    enabled: sorted.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      /* leads.ai_status is newer than the generated Database type (R-2039) — untyped read. */
      const db = createClient() as unknown as {
        from(t: "leads"): {
          select(c: string): { in(col: string, v: readonly string[]): { not(col: string, op: string, v: null): Promise<{ data: Array<{ id: string; ai_status: string | null }> | null; error: unknown }> } };
        };
      };
      const { data: rows, error } = await db.from("leads").select("id, ai_status").in("id", sorted).not("ai_status", "is", null);
      if (error) throw error;
      return rows ?? [];
    },
  });
  return React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data ?? []) if (r.ai_status) m.set(r.id, r.ai_status);
    return m;
  }, [data]);
}
