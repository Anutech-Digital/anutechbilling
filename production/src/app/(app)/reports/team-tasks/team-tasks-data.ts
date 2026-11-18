/**
 * R-2932 — the tasks Reports → Team tasks counts: every open task, plus the done ones ticked
 * or due inside the last 8 weeks. Read-only, five columns, all pages, one tenant (RLS + an
 * explicit tenant filter). Under the ["tasks", …] cache key, so a task save refreshes it.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAllRows, type PageResponse } from "@/lib/ops/fetch-all";
import { createClient } from "@/lib/supabase/client";
import { TASK_OPEN_STATUSES } from "@/lib/queries/tasks";
import { mergeById, reportRangeStartUtc, REPORT_TASK_SELECT, type ReportTask } from "./team-tasks";

type TasksDb = Pick<ReturnType<typeof createClient>, "from">;
type Page = PromiseLike<PageResponse<ReportTask>>;

export async function fetchTeamTasks(supabase: TasksDb, tenantId: string, now: Date = new Date()): Promise<ReportTask[]> {
  const fromISO = reportRangeStartUtc(now);
  const base = () => supabase.from("tasks").select(REPORT_TASK_SELECT).eq("tenant_id", tenantId);
  const [open, doneRecently, dueRecently] = await Promise.all([
    fetchAllRows<ReportTask>((from, to) => base()
      .in("status", [...TASK_OPEN_STATUSES])
      .order("id", { ascending: true })
      .range(from, to) as unknown as Page),
    fetchAllRows<ReportTask>((from, to) => base()
      .eq("status", "done")
      .gte("completed_at", fromISO)
      .order("id", { ascending: true })
      .range(from, to) as unknown as Page),
    fetchAllRows<ReportTask>((from, to) => base()
      .eq("status", "done")
      .gte("due_at", fromISO)
      .order("id", { ascending: true })
      .range(from, to) as unknown as Page),
  ]);
  return mergeById(open, doneRecently, dueRecently);
}

export function useTeamTasks(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ["tasks", "team-report", tenantId],
    enabled: !!tenantId,
    queryFn: () => fetchTeamTasks(createClient(), tenantId!),
  });
}
