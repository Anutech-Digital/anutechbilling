/**
 * Tasks — follow-up to-dos for sales reps.
 *
 * All hooks are tenant-scoped via RLS. Mutations fetch the current
 * tenant_id + auth.uid() for the owner on create (same pattern as
 * useCreateLead).
 */
"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAllRows, fetchAllRowsIn, idsKey, type PageResponse } from "@/lib/ops/fetch-all";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Database, Task } from "@/lib/supabase/database.types";

type TaskInsert = Database["public"]["Tables"]["tasks"]["Insert"];
type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

/**
 * A task plus the display name of whatever it's linked to (lead / customer /
 * quote), pulled in one query via PostgREST embeds so the Tasks list can show
 * "who is this about" without N extra lookups. At most one link is set.
 */
export type TaskWithLink = Task & {
  /* R-279: contact fields too — a lead with no company is named by its contact (leadTitle). */
  leads?:     { company: string; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null } | null;
  /* R-354: the customer's contact phone/email too, so a task row can call / WhatsApp / copy. */
  customers?: { name: string; contact_name?: string | null; contact_phone?: string | null; contact_email?: string | null } | null;
  quotes?:    { customer_name: string } | null;
};

/**
 * One select for every task list: the task plus whom it is about, embedded through the
 * task's own foreign keys (one request, no per-row lookups). The embedded lead / customer
 * rows are read under their own RLS, so they are always the task's tenant.
 */
export const TASK_SELECT =
  "*, leads(company, contact_name, contact_email, contact_phone), customers(name, contact_name, contact_phone, contact_email), quotes(customer_name)";

// ────────────────────────────────────────────────────────────────
// Filters
// ────────────────────────────────────────────────────────────────

export type TaskBucket = "today" | "overdue" | "upcoming" | "done" | "all";

/**
 * Compute the IST date boundary for "today" — used to slice tasks
 * into Today / Upcoming / Overdue buckets without TZ confusion.
 */
function todayBoundariesIST(): { startISO: string; endISO: string } {
  const now = new Date();
  // Convert "now" to IST string then back to a Date so we get IST midnight
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istMid = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  // Subtract 5.5h to express IST midnight as a UTC instant
  const startUTC = new Date(istMid.getTime() - (5.5 * 60 * 60 * 1000));
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: startUTC.toISOString(), endISO: endUTC.toISOString() };
}

// ────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────

/** All tasks in the tenant. Used by the /tasks list page. */
export function useTasks(bucket: TaskBucket = "all") {
  return useQuery({
    queryKey: ["tasks", bucket],
    queryFn: async (): Promise<TaskWithLink[]> => {
      const supabase = createClient();
      // Embed the linked entity's display name (lead company / customer name /
      // quote customer) so the list can show who each task is about.
      let q = supabase.from("tasks").select(TASK_SELECT);

      const { startISO, endISO } = todayBoundariesIST();

      switch (bucket) {
        case "today":
          q = q.eq("status", "pending").gte("due_at", startISO).lt("due_at", endISO);
          break;
        case "overdue":
          q = q.eq("status", "pending").lt("due_at", startISO);
          break;
        case "upcoming":
          q = q.eq("status", "pending").gte("due_at", endISO);
          break;
        case "done":
          q = q.eq("status", "done");
          break;
        case "all":
        default:
          // no filter
          break;
      }

      const order: { ascending: boolean } = { ascending: bucket === "upcoming" || bucket === "today" };
      const { data, error } = await q.order("due_at", order);
      if (error) throw error;
      return (data ?? []) as unknown as TaskWithLink[];
    },
  });
}

/**
 * R-354 — the /tasks page in one read: every open task (pending / snoozed, all pages) plus
 * the 100 most recently completed, with the linked lead / customer contact embedded
 * (TASK_SELECT). Grouped into Overdue / Today / Upcoming / Done on the client by IST day
 * (components/features/tasks/task-groups.ts) — replaces five per-tab queries. Filtered by
 * tenant explicitly as well as by RLS.
 */
export const DONE_TASKS_SHOWN = 100;

export function useTaskList(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ["tasks", "list", tenantId],
    enabled: !!tenantId,
    queryFn: () => fetchTaskList(createClient(), tenantId!),
  });
}

type TasksDb = Pick<ReturnType<typeof createClient>, "from">;

/** The useTaskList read, separate so a test can drive it with a stub client. */
export async function fetchTaskList(supabase: TasksDb, tenantId: string): Promise<TaskWithLink[]> {
  const [open, done] = await Promise.all([
    fetchAllRows<TaskWithLink>((from, to) => supabase
      .from("tasks")
      .select(TASK_SELECT)
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "snoozed"])
      .order("due_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResponse<TaskWithLink>>),
    supabase
      .from("tasks")
      .select(TASK_SELECT)
      .eq("tenant_id", tenantId)
      .eq("status", "done")
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(DONE_TASKS_SHOWN),
  ]);
  if (done.error) throw done.error;
  return [...open, ...((done.data ?? []) as unknown as TaskWithLink[])];
}

/**
 * Open (pending / snoozed) tasks for THESE leads — the leads list's task chip
 * (list-selectors.ts#openTaskIndex). WC-scale (30 Sep 2026): the list used useTasks("all"),
 * every task in the tenant with three embeds, cut at PostgREST's 1000 rows — so a lead whose
 * task was not among them showed no chip. Only the columns the chip reads, 200 lead ids a
 * request, every page read (lib/ops/fetch-all.ts). Under ["tasks"], so every task
 * mutation's invalidation reaches it.
 */
export function useOpenTasksForLeads(leadIds: readonly string[]) {
  const ids = idsKey(leadIds);
  return useQuery({
    queryKey: ["tasks", "open-for-leads", ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Pick<Task, "id" | "lead_id" | "status" | "due_at">[]> => {
      const supabase = createClient();
      return fetchAllRowsIn(ids, (chunkIds, from, to) => supabase
        .from("tasks")
        .select("id, lead_id, status, due_at")
        .in("lead_id", chunkIds)
        .in("status", ["pending", "snoozed"])
        .order("id", { ascending: true })
        .range(from, to));
    },
  });
}

/**
 * Tasks linked to a specific lead — used inside the lead drawer.
 * Excludes 'cancelled' since those are out of mind for the rep.
 */
export function useTasksForLead(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ["tasks", "by-lead", leadId],
    enabled: !!leadId,
    queryFn: async (): Promise<Task[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .eq("lead_id", leadId!)
        .neq("status", "cancelled")
        .order("due_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * "Today + overdue" count for the top-bar bell badge.
 * Cheap query — count(*) head-only.
 */
export function useTaskCountDueOrOverdue() {
  return useQuery({
    queryKey: ["tasks", "count-due-or-overdue"],
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      const { endISO } = todayBoundariesIST();
      // pending AND due_at < endOfToday (covers both overdue + today)
      const { count, error } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lt("due_at", endISO);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 30_000,
  });
}

// ────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<TaskInsert, "tenant_id" | "owner_id"> & { owner_id?: string | null }) => {
      const supabase = createClient();

      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          ...input,
          tenant_id: me.tenant_id,
          owner_id:  input.owner_id ?? authData.user.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      /* A lead task now sets the lead's follow_up_date (migration 20261009160000). */
      if (row?.lead_id) qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Follow-up scheduled");
    },
    onError: (err) => toastError(err),
  });
}

/** Generic patch — most callers want completeTask / snoozeTask helpers below. */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TaskUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tasks")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err) => toastError(err),
  });
}

type TaskPatch = Partial<Pick<Task, "status" | "completed_at" | "completed_by">>;

/**
 * R-354 — `patch` applied to task `id` inside one ["tasks", …] cache entry (a list, or the
 * single-task deep-link query). Anything that is not a task row (the bell's count) comes
 * back untouched. Pure, so the optimistic path is testable without a server.
 */
export function patchTaskInCache(old: unknown, id: string, patch: TaskPatch): unknown {
  const hit = (row: unknown): row is { id: string } =>
    !!row && typeof row === "object" && (row as { id?: unknown }).id === id;
  if (Array.isArray(old)) {
    return old.some(hit) ? old.map((row) => (hit(row) ? { ...row, ...patch } : row)) : old;
  }
  return hit(old) ? { ...old, ...patch } : old;
}

type QC = ReturnType<typeof useQueryClient>;
type CacheSnapshot = [readonly unknown[], unknown][];

function optimisticPatch(qc: QC, id: string, patch: TaskPatch): CacheSnapshot {
  const snapshot = qc.getQueriesData<unknown>({ queryKey: ["tasks"] });
  qc.setQueriesData<unknown>({ queryKey: ["tasks"] }, (old: unknown) => patchTaskInCache(old, id, patch));
  return snapshot;
}

function restoreSnapshot(qc: QC, snapshot: CacheSnapshot | undefined) {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

export const UNDO_TOAST_MS = 5_000;

/** Put a completed task back to pending — the Undo on the "Marked done" toast. */
export function useReopenTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("tasks")
        .update({ status: "pending", completed_at: null, completed_by: null })
        .eq("id", id);
      if (error) throw error;
      return id;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      return { snapshot: optimisticPatch(qc, id, { status: "pending", completed_at: null, completed_by: null }) };
    },
    onError: (err, _id, ctx) => {
      restoreSnapshot(qc, ctx?.snapshot);
      toastError(err, { fallback: "Couldn't undo — the task is still marked done." });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

/**
 * Mark a task done — one click. R-354: optimistic (the row moves to Done at once), rolled
 * back with toastError when the save fails, and the success toast carries a 5-second Undo.
 * Completion stamps (completed_at, completed_by) are applied by the DB trigger.
 */
export function useCompleteTask() {
  const qc = useQueryClient();
  const reopen = useReopenTask();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tasks")
        .update({ status: "done" })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      return { snapshot: optimisticPatch(qc, id, { status: "done", completed_at: new Date().toISOString() }) };
    },
    onError: (err, _id, ctx) => {
      restoreSnapshot(qc, ctx?.snapshot);
      toastError(err, { fallback: "Couldn't mark the task done." });
    },
    onSuccess: (_data, id) => {
      toast.success("Marked done ✓", {
        duration: UNDO_TOAST_MS,
        action: { label: "Undo", onClick: () => reopen.mutate(id) },
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

/** Push the due_at forward by N minutes (default 24h) and bump snooze_count. */
export function useSnoozeTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, minutes = 24 * 60 }: { id: string; minutes?: number }) => {
      const supabase = createClient();
      // Read current task to compute new due_at + snooze_count
      const { data: cur, error: rErr } = await supabase
        .from("tasks").select("due_at, snooze_count").eq("id", id).single();
      if (rErr || !cur) throw rErr ?? new Error("Task not found");

      const newDue = new Date(new Date(cur.due_at).getTime() + minutes * 60_000);

      const { data, error } = await supabase
        .from("tasks")
        .update({
          due_at: newDue.toISOString(),
          snooze_count: (cur.snooze_count ?? 0) + 1,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast(`Snoozed to ${new Date(data.due_at).toLocaleString("en-IN")}`);
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("Task deleted");
    },
    onError: (err) => toastError(err),
  });
}
