/**
 * R-2931 — the tasks due inside one month grid (/tasks/calendar). Read-only; saved under the
 * ["tasks", …] cache key so every task mutation in lib/queries/tasks.ts refreshes it.
 */
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchAllRows, type PageResponse } from "@/lib/ops/fetch-all";
import { createClient } from "@/lib/supabase/client";
import { TASK_SELECT, type TaskWithLink } from "@/lib/queries/tasks";
import { gridRangeUtc } from "./calendar-grid";

type TasksDb = Pick<ReturnType<typeof createClient>, "from">;

export const calendarTasksKey = (tenantId: string | null | undefined, month: string) =>
  ["tasks", "calendar", tenantId, month] as const;

/** Every task (open or done, not cancelled) due in the visible grid — all pages, one tenant.
 *  R-2957: not a goal row — its sub-tasks are the work and sit on their own due days. */
export async function fetchCalendarTasks(supabase: TasksDb, tenantId: string, month: string): Promise<TaskWithLink[]> {
  const { fromISO, toISO } = gridRangeUtc(month);
  return fetchAllRows<TaskWithLink>((from, to) => supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("tenant_id", tenantId)
    .eq("is_goal", false)
    .neq("status", "cancelled")
    .gte("due_at", fromISO)
    .lt("due_at", toISO)
    .order("due_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to) as unknown as PromiseLike<PageResponse<TaskWithLink>>);
}

export function useCalendarTasks(tenantId: string | null | undefined, month: string) {
  return useQuery({
    queryKey: calendarTasksKey(tenantId, month),
    enabled: !!tenantId,
    placeholderData: keepPreviousData,
    queryFn: () => fetchCalendarTasks(createClient(), tenantId!, month),
  });
}
