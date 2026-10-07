/**
 * Leads — server + client data hooks.
 *
 * Server: use `fetchLeads()` in Server Components.
 * Client: use `useLeads()` hook (TanStack Query).
 */
"use client";

import * as React from "react";
import {
  keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { friendlyDeleteError } from "@/lib/deals/delete-rules";
import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";
import type { Json, Lead, Database } from "@/lib/supabase/database.types";
import { flattenPages } from "@/lib/queries/keyset";
import { fetchAllRows, fetchAllRowsIn, idsKey } from "@/lib/ops/fetch-all";
import { istToday } from "@/lib/dates/ist";
import {
  LEAD_LIST_COLUMNS, toLeadCountsFilters, toListLeadsFilters,
  type LeadCounts, type LeadListCursor, type LeadListFilters, type LeadListPage, type LeadListRow,
} from "@/lib/leads/list-page";
import type { JunkReasonId } from "@/lib/leads/qualification";
import { hasDupKeys, type DupCheckKeys, type LeadDuplicate } from "@/lib/leads/duplicate-check";

// ============================================================
// Optimistic writes across every cached shape of "leads"
// ============================================================
/* S40: the leads page no longer reads the ["leads"] array — its list is paged
   (["leads","pages",…]) and its board is ["leads","board"]. The mutations below used to
   patch only ["leads"], so on the page the optimistic edit silently stopped showing and a
   junked row sat there until the refetch. These patch every lead-shaped cache under
   ["leads"] and roll every one of them back on failure. */
type LeadCacheSnapshot = Array<[QueryKey, unknown]>;

function isRow(v: unknown): v is { id: string } {
  return typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";
}
function isPaged(v: unknown): v is { pages: { rows: unknown[] }[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { pages?: unknown }).pages);
}
/** The board's { rows, totals } (useLeadsBoard). */
function isRowsBox(v: unknown): v is { rows: unknown[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { rows?: unknown }).rows);
}

async function patchCachedLeads(qc: QueryClient, ids: readonly string[], patch: Partial<Lead>): Promise<LeadCacheSnapshot> {
  await qc.cancelQueries({ queryKey: ["leads"] });
  const snapshot = qc.getQueriesData({ queryKey: ["leads"] });
  const idSet = new Set(ids);
  const fix = (r: unknown) => (isRow(r) && idSet.has(r.id) ? { ...r, ...patch } : r);
  qc.setQueriesData({ queryKey: ["leads"] }, (old: unknown) => {
    if (Array.isArray(old)) return old.map(fix);
    if (isPaged(old)) return { ...old, pages: old.pages.map((p) => ({ ...p, rows: p.rows.map(fix) })) };
    if (isRowsBox(old)) return { ...old, rows: old.rows.map(fix) };
    if (isRow(old) && "company" in old) return fix(old);   // one lead (useLead)
    return old;                                              // counts, quote map, …
  });
  return snapshot;
}

function restoreCachedLeads(qc: QueryClient, snapshot: LeadCacheSnapshot | undefined) {
  for (const [key, data] of snapshot ?? []) qc.setQueryData(key, data);
}

// ============================================================
// Read
// ============================================================
/**
 * @deprecated WC-scale (30 Sep 2026): select("*") of every lead, and PostgREST stops at 1000
 * rows without saying so — any count or total built on it is wrong past the thousandth lead.
 * Use a bounded read instead: useLeadCounts / useLeadsInfinite (the leads page),
 * useLeadStageCounts / useLeadStageTotals (reports, dashboard), useLeadsCreatedSince (lead
 * sources), useLead(id) (one lead). Kept only for quote-builder.tsx (Abhishek's area), which
 * looks one lead up by id in it.
 */
export function useLeads() {
  return useQuery({
    queryKey: ["leads"],
    queryFn: async (): Promise<Lead[]> => {
      const supabase = createClient();
      // Removed 2026-08-13: a fallback that re-queried with three hardcoded
      // tenant UUIDs whenever this returned empty. It could never help — RLS
      // (verified on prod: enabled on `leads` with 4 policies) applies to both
      // queries, so the retry returns exactly the same rows. All it did was make
      // "no leads yet" indistinguishable from "auth/tenant is broken". One of the
      // three UUIDs also belonged to Delfos Technologies, an unrelated tenant.
      /* R-294: paged past the 1000-row cap; order ends on the unique id. */
      return fetchAllRows((from, to) => supabase
        .from("leads")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
    },
  });
}

/**
 * Leads in keyset pages from `list_leads()` (S37; views, folders, the owner filter and the
 * wait order since S40, migration 20260929130000) — slim rows, server-side filters.
 *
 * NOT a drop-in for useLeads(): the rows are LeadListRow (no notes / attribution columns).
 * The Sales & Pipeline list reads this and its chips read useLeadCounts() with the SAME
 * filters, so a chip and the list cannot disagree (lead_counts.test.sql). Under ["leads"],
 * so every lead mutation's invalidation reaches it. `placeholderData` keeps the old rows on
 * screen while a new filter loads, instead of flashing an empty list.
 */
export function useLeadsInfinite(filters: LeadListFilters = {}, limit = 50, opts: { enabled?: boolean } = {}) {
  const f = toListLeadsFilters(filters);
  const q = useInfiniteQuery({
    queryKey: ["leads", "pages", f, limit],
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    initialPageParam: null as LeadListCursor | null,
    queryFn: async ({ pageParam }): Promise<LeadListPage> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("list_leads", {
        p_cursor: pageParam as unknown as Json,
        p_limit: limit,
        p_filters: f as unknown as Json,
      });
      if (error) throw error;
      const page = (data ?? { rows: [], next_cursor: null }) as unknown as LeadListPage;
      return { rows: page.rows ?? [], next_cursor: page.next_cursor ?? null };
    },
    getNextPageParam: (last) => last.next_cursor,
  });
  const data = React.useMemo(
    () => (q.data ? flattenPages(q.data.pages, (l) => l.id) : undefined),
    [q.data],
  );
  return { ...q, data };
}

/**
 * Every number the Sales & Pipeline screen shows, from `lead_counts()` (S40) — for the same
 * filters the list uses (paging-only keys dropped). One round trip; see LeadCounts for what
 * each section counts over.
 */
export function useLeadCounts(filters: LeadListFilters = {}) {
  const f = toLeadCountsFilters(filters);
  return useQuery({
    queryKey: ["leads", "counts", f],
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<LeadCounts> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("lead_counts", { p_filters: f as unknown as Json });
      if (error) throw error;
      return data as unknown as LeadCounts;
    },
  });
}

// ── Slim, bounded reads (S40) ────────────────────────────────────────────────
// Everything below names its columns and (except the board and the export) caps its rows.
// They replaced useLeads() — select("*") of every lead — in places that show a handful:
// the three layout panels mounted on EVERY page, and the parts of the leads page that are
// not the list. The column list is the list row's (LEAD_LIST_COLUMNS), so a slim row can
// go anywhere a list row goes.

const SLIM = LEAD_LIST_COLUMNS.join(", ");

/** Workspace cut for a PostgREST read: listed owners OR unowned (list-selectors#inWorkspace). */
function ownerOr(ids: readonly string[]): string {
  return ids.length > 0 ? `owner_id.is.null,owner_id.in.(${ids.join(",")})` : "owner_id.is.null";
}

/** The board's columns (stage-meta.ts DEAL_STAGES) — lost has no column. */
export const BOARD_STAGES = ["new", "contact", "quote", "demo", "trial", "won"] as const satisfies readonly Lead["stage"][];
export type BoardStage = (typeof BOARD_STAGES)[number];
/** Cards read per column. A column with more says so (BoardData.totals) and the list view pages them all. */
export const BOARD_COLUMN_CAP = 200;

export interface BoardData {
  /** Up to BOARD_COLUMN_CAP newest rows per column, newest first. */
  rows: LeadListRow[];
  /** How many leads each column holds in total (same owner + junk cut as the rows). */
  totals: Partial<Record<BoardStage, number>>;
}

/**
 * The Kanban board's rows — slim columns, READ PER COLUMN (WC-scale, 30 Sep 2026).
 *
 * It used to be one select of every lead, newest first, cut at PostgREST's 1000-row max_rows
 * — so at 20,000 leads the board held whichever 1000 were newest, and a column's count was
 * however many of its deals happened to fall inside them: Won read 12 when it was 3,400.
 * Now each column is its own query, filtered on the server — the stage, the owner cut
 * (`ownerIds`, as useDueLeads) and junk (only the Junk view shows junk) — capped at
 * BOARD_COLUMN_CAP newest cards, with an exact count so the column can say "200 of 3,400".
 * The browser still applies the page's search / filters on top (list-selectors.ts#boardCut).
 */
/* `stages`: the columns this page shows (lib/leads/page-scope.ts) — /deals has no New /
   Contacted, so it does not read them at all. */
export function useLeadsBoard(
  enabled: boolean,
  opts: { ownerIds?: readonly string[] | null; junk?: boolean; stages?: readonly BoardStage[] } = {},
) {
  const ownerIds = opts.ownerIds ?? null;
  const junk = opts.junk ?? false;
  const stages = opts.stages ?? BOARD_STAGES;
  return useQuery({
    queryKey: ["leads", "board", ownerIds, junk, stages],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<BoardData> => {
      const supabase = createClient();
      const results = await Promise.all(stages.map((stage) => {
        let q = supabase
          .from("leads").select(SLIM, { count: "exact" })
          .eq("stage", stage)
          .eq("is_junk", junk);
        if (ownerIds) q = q.or(ownerOr(ownerIds));
        return q
          .order("created_at", { ascending: false }).order("id", { ascending: false })
          .limit(BOARD_COLUMN_CAP);
      }));
      const rows: LeadListRow[] = [];
      const totals = {} as BoardData["totals"];
      results.forEach((r, i) => {
        if (r.error) throw r.error;
        const got = (r.data ?? []) as unknown as LeadListRow[];
        rows.push(...got);
        totals[stages[i]] = r.count ?? got.length;
      });
      return { rows, totals };
    },
  });
}

/**
 * Follow-ups due today or earlier on open, non-junk leads, most overdue first — the call
 * queue's input (lib/leads/call-queue.ts#buildCallQueue re-checks every rule). Capped at
 * 500: the queue shows three, and its "N more due" line says when there are more.
 */
export function useDueLeads(ownerIds: readonly string[] | null, enabled = true) {
  const today = istToday();
  return useQuery({
    queryKey: ["leads", "due", today, ownerIds],
    enabled,
    queryFn: async (): Promise<LeadListRow[]> => {
      const supabase = createClient();
      let q = supabase
        .from("leads").select(SLIM)
        .eq("is_junk", false)
        .not("stage", "in", "(won,lost)")
        .lte("follow_up_date", today)
        .order("follow_up_date", { ascending: true })
        .limit(500);
      if (ownerIds) q = q.or(ownerOr(ownerIds));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LeadListRow[];
    },
  });
}

/** Lost leads, only the columns the loss-reasons card reads. */
export function useLostLeads(ownerIds: readonly string[] | null, enabled = true) {
  return useQuery({
    queryKey: ["leads", "lost", ownerIds],
    enabled,
    queryFn: async () => {
      const supabase = createClient();
      let q = supabase.from("leads").select("id, stage, value, lost_reason, lost_at").eq("stage", "lost");
      if (ownerIds) q = q.or(ownerOr(ownerIds));
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * The command palette's leads: the newest few when nothing is typed, else a server search
 * (list_leads' search — company, contact, email, phone, plan) capped at 25. It used to load
 * every lead so cmdk could filter them in the browser.
 */
export function useLeadSearch(query: string, enabled: boolean) {
  const q = query.trim() === "" ? "" : query;
  return useQuery({
    queryKey: ["leads", "palette", q],
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: async (): Promise<LeadListRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("list_leads", {
        p_cursor: null,
        p_limit: q ? 25 : 10,
        p_filters: toListLeadsFilters({ search: q, junk: "any" }) as unknown as Json,
      });
      if (error) throw error;
      return ((data as unknown as LeadListPage | null)?.rows ?? []);
    },
  });
}

/** Leads created in the last 7 days — the notification panel's "New lead" rows (it shows 30). */
export function useRecentLeads(enabled = true) {
  return useQuery({
    queryKey: ["leads", "recent-7d"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await supabase
        .from("leads").select("id, company, value, contact_name, created_at")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(30);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * The quick-actions panel's leads block: how many follow-ups are due today and overdue
 * (counts, not rows), and the three biggest late-stage deals.
 *
 * Same rules as the page now: open, non-junk leads, IST date. The panel used to count every
 * lead (won, lost and junk included) against the UTC date, so its "3 overdue" and the
 * page's Overdue view could name different numbers for the same morning.
 */
export function useLeadActionSummary(enabled = true) {
  const today = istToday();
  return useQuery({
    queryKey: ["leads", "action-summary", today],
    enabled,
    queryFn: async () => {
      const supabase = createClient();
      const open = () => supabase.from("leads").select("id", { count: "exact", head: true })
        .eq("is_junk", false).not("stage", "in", "(won,lost)");
      const [due, overdue, hot] = await Promise.all([
        open().eq("follow_up_date", today),
        open().lt("follow_up_date", today),
        supabase.from("leads").select("id, company, plan, seats, stage, value")
          .eq("is_junk", false).in("stage", ["quote", "trial", "demo"])
          .order("value", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(3),
      ]);
      for (const r of [due, overdue, hot]) if (r.error) throw r.error;
      return { dueToday: due.count ?? 0, overdue: overdue.count ?? 0, hot: hot.data ?? [] };
    },
  });
}

// ── Aggregate reads for pages that are not the leads page (WC-scale, 30 Sep 2026) ──────
// Reports, the dashboard and Lead Sources each called useLeads() — select("*") of every lead
// — and counted in the browser. PostgREST stops at 1000 rows without saying so, so at 20,000
// leads every one of those numbers was a count of the newest thousand. These return the
// numbers themselves (exact HEAD counts) or page through only the two or six columns a
// number needs. Junk is excluded everywhere, as the leads page's own totals exclude it
// (list-selectors.ts#pipelineTotals: "EVERY NON-JUNK LEAD IS A DEAL").

/** Exact non-junk lead count per stage — one HEAD request per stage, in parallel. */
export function useLeadStageCounts(stages: readonly Lead["stage"][]) {
  return useQuery({
    queryKey: ["leads", "stage-counts", [...stages]],
    queryFn: async (): Promise<Partial<Record<Lead["stage"], number>>> => {
      const supabase = createClient();
      const res = await Promise.all(stages.map((stage) => supabase
        .from("leads").select("id", { count: "exact", head: true })
        .eq("is_junk", false).eq("stage", stage)));
      const out: Partial<Record<Lead["stage"], number>> = {};
      res.forEach((r, i) => {
        if (r.error) throw r.error;
        out[stages[i]] = r.count ?? 0;
      });
      return out;
    },
  });
}

export type StageTotals = Partial<Record<Lead["stage"], { count: number; value: number }>>;

/**
 * Count and summed `value` per stage over every non-junk, non-lost lead — the dashboard's
 * "Pipeline by Stage". Pages through `stage, value` only (lib/ops/fetch-all.ts), so the sums
 * are over every lead, not the first 1000. A one-round-trip RPC would be cheaper still at
 * 20k leads; that needs a migration + a types regen, so it is a follow-up, not this change.
 */
export function useLeadStageTotals(enabled = true) {
  return useQuery({
    queryKey: ["leads", "stage-totals"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<StageTotals> => {
      const supabase = createClient();
      const rows = await fetchAllRows((from, to) => supabase
        .from("leads").select("stage, value")
        .eq("is_junk", false).neq("stage", "lost")
        .order("id", { ascending: true })
        .range(from, to));
      const out: StageTotals = {};
      for (const r of rows) {
        const t = (out[r.stage] ??= { count: 0, value: 0 });
        t.count += 1;
        t.value += r.value ?? 0;
      }
      return out;
    },
  });
}

/** The dashboard's lead cards: exact counts, and only the handful of rows each card lists. */
export function useDashboardLeads(enabled = true) {
  const today = istToday();
  return useQuery({
    queryKey: ["leads", "dashboard", today],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const weekOut = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const open = () => supabase.from("leads").select("id", { count: "exact", head: true })
        .eq("is_junk", false).not("stage", "in", "(won,lost)");
      const [newToday, overdue, upcoming, recent] = await Promise.all([
        supabase.from("leads").select("id", { count: "exact", head: true })
          .eq("is_junk", false).gte("created_at", dayStart.toISOString()),
        open().lt("follow_up_date", today),
        /* Overdue first, then the coming week — the card shows five. */
        /* R-279: contact fields so a lead with no company is named by its contact. */
        supabase.from("leads").select("id, company, contact_name, contact_email, contact_phone, stage, follow_up_date")
          .eq("is_junk", false).not("stage", "in", "(won,lost)")
          .not("follow_up_date", "is", null).lte("follow_up_date", weekOut)
          .order("follow_up_date", { ascending: true }).order("id", { ascending: true })
          .limit(5),
        /* The activity feed shows six items across leads and quotes. */
        supabase.from("leads").select("id, company, contact_name, contact_email, contact_phone, stage, plan, value, created_at")
          .eq("is_junk", false).gte("created_at", since24h)
          .order("created_at", { ascending: false }).limit(6),
      ]);
      for (const r of [newToday, overdue, upcoming, recent]) if (r.error) throw r.error;
      return {
        newToday: newToday.count ?? 0,
        overdueFollowups: overdue.count ?? 0,
        upcoming: upcoming.data ?? [],
        recent: recent.data ?? [],
      };
    },
  });
}

export type LeadSourceRow = Pick<Lead, "id" | "company" | "contact_name" | "contact_email" | "source" | "stage" | "created_at">;

/**
 * Every lead created since `sinceISO`, newest first, with the columns Lead Sources shows —
 * paged (lib/ops/fetch-all.ts), so a busy month is counted whole. Junk included, as the page
 * always counted it (a junk lead still came in through a channel).
 */
export function useLeadsCreatedSince(sinceISO: string) {
  return useQuery({
    queryKey: ["leads", "created-since", sinceISO],
    staleTime: 60_000,
    queryFn: async (): Promise<LeadSourceRow[]> => {
      const supabase = createClient();
      return fetchAllRows((from, to) => supabase
        .from("leads").select("id, company, contact_name, contact_email, source, stage, created_at")
        .gte("created_at", sinceISO)
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(from, to));
    },
  });
}

/** How many leads the workspace has, all time, junk included — an exact HEAD count. */
export function useLeadTotalCount() {
  return useQuery({
    queryKey: ["leads", "total-count"],
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      const { count, error } = await supabase.from("leads").select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/**
 * Every lead the caller can see, for "Export CSV" — fetched when the button is pressed, in
 * 1000-row pages (PostgREST's max_rows), with only the columns the CSV writes. The old
 * export wrote whatever useLeads() had loaded, which stopped silently at 1000.
 */
export async function fetchLeadsForExport(): Promise<LeadListRow[]> {
  const supabase = createClient();
  const out: LeadListRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("leads").select(SLIM)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as LeadListRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** The columns the merge dialog reads (its "richest record" pick counts gstin and notes). */
export const MERGE_COLUMNS =
  "id, company, contact_name, contact_email, contact_phone, plan, seats, value, gstin, notes, created_at" as const;
export type MergeLead = Pick<Lead, "id" | "company" | "contact_name" | "contact_email" | "contact_phone"
  | "plan" | "seats" | "value" | "gstin" | "notes" | "created_at">;

/**
 * A lead and the leads that duplicate it (list_leads' dup_of — same workspace and keys as
 * the row's "Duplicate?" flag), with the columns the merge dialog needs. Fetched when the
 * rep presses Merge; the page no longer holds every lead to look the matches up.
 */
export async function fetchMergeCluster(leadId: string, ownerIds: readonly string[] | null): Promise<MergeLead[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_leads", {
    p_cursor: null,
    p_limit: 200,
    p_filters: toListLeadsFilters({ junk: "any", dup_of: leadId, owner_ids: ownerIds ? [...ownerIds] : undefined }) as unknown as Json,
  });
  if (error) throw error;
  const ids = [leadId, ...((data as unknown as LeadListPage | null)?.rows ?? []).map((r) => r.id)];
  if (ids.length < 2) return [];
  const { data: rows, error: e2 } = await supabase.from("leads").select(MERGE_COLUMNS).in("id", ids);
  if (e2) throw e2;
  const byId = new Map((rows ?? []).map((r) => [r.id, r as MergeLead]));
  return ids.map((id) => byId.get(id)).filter((r): r is MergeLead => Boolean(r));
}

/**
 * Existing leads that the lead being typed would duplicate — same GSTIN, email, phone or
 * company key, strongest match first (find_lead_duplicates, R-072 / migration
 * 20260930200000; lib/leads/duplicate-check.ts). The Add-lead form's warning. Debounced by the
 * caller, which sends only keys worth asking (dupCheckKeys); nothing is asked before that.
 * RLS applies (invoker): a rep is warned about the leads they can see.
 */
export function useLeadDuplicateCheck(keys: DupCheckKeys, excludeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["leads", "dup-check", keys.phone, keys.email, keys.gstin, keys.company, excludeId ?? null],
    enabled: enabled && hasDupKeys(keys),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: async (): Promise<LeadDuplicate[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("find_lead_duplicates", {
        p_phone: keys.phone,
        p_email: keys.email,
        p_gstin: keys.gstin,
        p_company: keys.company,
        ...(excludeId ? { p_exclude_id: excludeId } : {}),
      });
      if (error) throw error;
      return (data ?? []) as LeadDuplicate[];
    },
  });
}

/** A lead's name by id — for a picker that shows a chosen lead it did not load. */
export function useLeadLabel(id: string | null | undefined) {
  return useQuery({
    queryKey: ["leads", "label", id],
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads").select("id, company, contact_name").eq("id", id!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Har lead ki SABSE NAYI quote — id aur status — ek hi query me.
 *
 * ─── KYON ───────────────────────────────────────────────────────────────────
 * Pardeep, 31 Aug 2026, website-form ki lead ko list me dekh kar: "lead to banti hai par
 * ye nahi pata lagta ki isko quote bheja gaya hai ya nahi… aur related quote wahin se
 * open bhi hona chahiye." Wo sach pehle sirf lead ke NOTES me dafan tha — jise list par
 * koi nahi padhta — jabki quotes table me `lead_id` pehle se hai.
 *
 * Ek map isliye, N queries nahi: list me 30 lead par 30 round-trip wahi class ki
 * sust-page banati jo is screen par pehle napi ja chuki hai. RLS tenant scope karta hai.
 * "Sabse nayi" isliye ki requote hone par purani draft nahi, aaj wali dikhe.
 */
export interface LeadQuoteRef {
  id: string;
  status: string | null;
}

/**
 * WC-scale (30 Sep 2026): for THESE leads only — the rows on screen. It used to read every
 * quote that had a lead, which past PostgREST's 1000-row cap meant the newest thousand: an
 * older lead's quote pill silently vanished. Now 200 lead ids a request, every page read
 * (lib/ops/fetch-all.ts). Newest first inside each chunk — a lead's quotes are all in its
 * one chunk, so "first seen = newest" still holds.
 */
export function useLeadQuotes(leadIds: readonly string[]) {
  const ids = idsKey(leadIds);
  return useQuery({
    queryKey: ["leads", "quotes-by-lead", ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Record<string, LeadQuoteRef>> => {
      const supabase = createClient();
      const data = await fetchAllRowsIn(ids, (chunkIds, from, to) => supabase
        .from("quotes")
        .select("id, lead_id, status, created_at")
        .in("lead_id", chunkIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
      const map: Record<string, LeadQuoteRef> = {};
      for (const q of data as { id: string; lead_id: string | null; status: string | null }[]) {
        if (q.lead_id && !map[q.lead_id]) map[q.lead_id] = { id: q.id, status: q.status };
      }
      return map;
    },
  });
}

/** A single lead by id — used e.g. to prefill a prospect quote's WhatsApp number. */
export function useLead(id: string | undefined) {
  return useQuery({
    queryKey: ["leads", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Lead | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("leads").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Lead | null;
    },
  });
}

// ============================================================
// Update stage (drag-and-drop)
// ============================================================
export function useUpdateLeadStage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (
      { id, stage, lostReason, lostNote }:
      { id: string; stage: Lead["stage"]; lostReason?: string | null; lostNote?: string | null },
    ) => {
      const supabase = createClient();
      // Loss capture rides along with the stage change so the two can't diverge —
      // a lead is never "lost" in one write and "explained" in another that might
      // fail. Moving OUT of lost clears the fields, otherwise a revived deal keeps
      // a stale reason and quietly poisons the loss analytics.
      const loss = stage === "lost"
        ? { lost_reason: lostReason ?? null, lost_note: lostNote ?? null, lost_at: new Date().toISOString() }
        : { lost_reason: null, lost_note: null, lost_at: null };
      const patch: LeadUpdate = { stage, ...loss };
      const { data, error } = await supabase
        .from("leads")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    // Optimistic update — UI updates immediately, rolls back on error
    onMutate: async ({ id, stage }) => {
      const previous = await patchCachedLeads(qc, [id], { stage });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      restoreCachedLeads(qc, ctx?.previous);
      // The optimistic move was just rolled back — say so, or the card silently
      // snapping back to its old column looks like the drag simply didn't work.
      toastError(err, {
        fallback: "Could not move the lead",
        description: "The card went back to its previous stage — nothing was saved.",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
  });
}

/**
 * Mark one or more leads as junk (spam/fake) — or restore them. Junk leads drop
 * out of every working view and show only under the "Junk" view.
 */
export function useSetLeadJunk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      { ids, isJunk, reason, note }: {
        ids: string[];
        isJunk: boolean;
        /** WHY. Required by the drawer dialog; see lib/leads/qualification.ts. */
        reason?: JunkReasonId;
        note?: string;
      },
    ) => {
      const supabase = createClient();
      /* Un-junking CLEARS the reason and the timestamp. Leaving a stale "fake_phone"
         on a lead that is live again would put it back in the junk reports it just
         escaped, and the next reader would trust it. */
      const patch = isJunk
        ? {
            is_junk: true,
            junk_reason: reason ?? null,
            junk_note: note?.trim() ? note.trim() : null,
            junked_at: new Date().toISOString(),
          }
        : { is_junk: false, junk_reason: null, junk_note: null, junked_at: null };
      const { error } = await supabase.from("leads").update(patch).in("id", ids);
      if (error) throw error;
    },
    /* Optimistic, like the stage and inline-cell mutations above. This one was NOT,
       and it is the mutation behind a 1-tap "Junk" chip in a triage queue: the rep
       taps, the row sits there until the server replies, and they tap again. Marking
       junk removes the row from every working view, so the optimistic write IS the
       feedback — there is no cell left on screen to animate. */
    onMutate: async ({ ids, isJunk }) => {
      const previous = await patchCachedLeads(qc, ids, { is_junk: isJunk });
      return { previous };
    },
    onSuccess: (_r, { ids, isJunk }) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success(isJunk ? `${ids.length} lead${ids.length > 1 ? "s" : ""} marked junk` : "Restored from junk");
    },
    onError: (err, _vars, ctx) => {
      // Put the rows back, or the rep believes leads were hidden that were not.
      restoreCachedLeads(qc, ctx?.previous);
      toastError(err, { description: "The leads were put back — nothing was changed." });
    },
  });
}

/** AI junk verdict for one lead (returned by /api/ai/classify-junk). */
export interface JunkAiVerdict {
  id: string;
  suspect: boolean;
  reason: string;
  confidence: number;
}

/**
 * Ask the AI to classify a batch of leads as junk / genuine. Read-only — returns
 * verdicts; the operator confirms + marks via useSetLeadJunk. Falls back to the
 * deterministic heuristic server-side when no Gemini key is set (mode="stub").
 */
export function useClassifyJunk() {
  return useMutation({
    mutationFn: async (leadIds: string[]): Promise<{ verdicts: JunkAiVerdict[]; mode: "gemini" | "stub" }> => {
      const res = await fetch("/api/ai/classify-junk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not run AI review.");
      return data as { verdicts: JunkAiVerdict[]; mode: "gemini" | "stub" };
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Create — fetches current tenant_id, then inserts the lead
// ============================================================
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

/** @param opts.quiet no "Lead created" toast — for a form that confirms the save itself (Quick add, R-099). */
export function useCreateLead(opts: { quiet?: boolean } = {}) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (lead: Omit<LeadInsert, "tenant_id">) => {
      const supabase = createClient();

      /* R-001 (raised by Abhishek back to Pardeep, 26 Sep 2026): this used to default to the
         seed tenant when the operator could not be identified, and to hand back a fake
         `L-<timestamp>` lead when the insert failed — so a lead could land in another
         company, or not land at all while the toast said "Lead created". Refuse instead;
         onError shows the reason. */
      const tenantId = await requireTenantId(supabase);

      const { data, error } = await supabase
        .from("leads")
        .insert({ ...lead, tenant_id: tenantId })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      if (!opts.quiet) toast.success("Lead created");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Update — edit any lead field (company, contact, plan, seats, value, notes, …)
// ============================================================
/**
 * @param opts.quiet suppress the success toast — for inline cell edits, where
 *   the saved value is visible in the cell itself and a toast per keystroke-ish
 *   edit is just noise. Errors still surface.
 */
export function useUpdateLead(opts: { quiet?: boolean } = {}) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: LeadUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    // Optimistic — an inline cell must feel instant, and the row is right there
    // to show the rollback if the write fails.
    onMutate: async ({ id, patch }) => {
      const previous = await patchCachedLeads(qc, [id], patch as Partial<Lead>);
      return { previous };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      if (!opts.quiet) toast.success("Lead updated");
    },
    onError: (err, _vars, ctx) => {
      restoreCachedLeads(qc, ctx?.previous);
      toastError(err, { description: "The cell was put back to its previous value — nothing was saved." });
    },
  });
}

// ============================================================
// Delete — permanently remove a lead
// ============================================================
export function useDeleteLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      /* .select() so a delete RLS silently filtered out (0 rows) is reported, not toasted
         as "deleted" — a policy refusal on DELETE returns no error, just nothing gone. */
      const { data, error } = await supabase.from("leads").delete().eq("id", id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw Object.assign(new Error("permission denied"), { code: "42501" });
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Deleted");
    },
    onError: (err) => {
      const e = err as { message?: string; code?: string };
      const friendly = friendlyDeleteError(e.message ?? "", e.code);
      if (friendly) toast.error("Not deleted", { description: friendly });
      else toastError(err);
    },
  });
}

// ============================================================
// Merge duplicates — fold a duplicate lead INTO a primary one.
// Atomic server-side (merge_leads RPC): repoints all child rows, backfills the
// primary's empty fields, keeps the bigger deal value, then deletes the
// duplicate. Only ever called after the operator confirms in the merge dialog.
// ============================================================
export function useMergeLeads() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ primaryId, duplicateId }: { primaryId: string; duplicateId: string }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("merge_leads", {
        p_primary_id: primaryId,
        p_duplicate_id: duplicateId,
      });
      if (error) throw error;
      return { primaryId, duplicateId };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
    onError: (err) => toastError(err),
  });
}

/* ── Ek insaan ki LEADS — contact/customer ke page ke liye (1 Sep 2026) ──────
   Pardeep: "lead ka koi contact hota hai to us contact ke page par uski leads
   bhi dikhao, jaise quotation/invoice dikhate hain." Pehchan teen raaste se:
   anchor (leads.contact_id — migration 0197, har lead par hai), email-match,
   phone-match (EXACT stored value; +91/space-variant yahan nahi judte — wo
   contacts-book ka last-10 merge hai, DB filter nahi).
   Teen chhoti queries, client par dedup — PostgREST ke or(in(...)) ke quoting
   jaal se seedha raasta. */
export function useLeadsForPerson(args: {
  contactId?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
}) {
  const contactId = args.contactId ?? null;
  const emails = (args.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const phones = (args.phones ?? []).map((p) => p.trim()).filter(Boolean);

  return useQuery({
    queryKey: ["leads-for-person", contactId, emails, phones],
    enabled: Boolean(contactId || emails.length || phones.length),
    queryFn: async (): Promise<Lead[]> => {
      const supabase = createClient();
      const picks = "id, company, contact_name, contact_email, contact_phone, stage, is_junk, value, seats, plan, created_at";
      const [byAnchor, byEmail, byPhone] = await Promise.all([
        contactId
          ? supabase.from("leads").select(picks).eq("contact_id", contactId)
          : Promise.resolve({ data: [], error: null }),
        emails.length
          ? supabase.from("leads").select(picks).in("contact_email", emails)
          : Promise.resolve({ data: [], error: null }),
        phones.length
          ? supabase.from("leads").select(picks).in("contact_phone", phones)
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const r of [byAnchor, byEmail, byPhone]) if (r.error) throw r.error;

      const seen = new Set<string>();
      const out: Lead[] = [];
      for (const l of [...(byAnchor.data ?? []), ...(byEmail.data ?? []), ...(byPhone.data ?? [])] as Lead[]) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        out.push(l);
      }
      out.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
      return out;
    },
  });
}

// ============================================================
// Project enquiries (migration 20260926110000)
// ============================================================

/** Our own GST state — the seller side of place of supply for a project quotation. */
export function useSellerState(enabled: boolean) {
  return useQuery({
    queryKey: ["tenant", "state_code"],
    enabled,
    queryFn: async (): Promise<string | null> => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) throw new Error("Not signed in");
      const { data: me, error } = await supabase.from("users").select("tenant_id").eq("id", auth.user.id).single();
      if (error) throw error;
      const { data: t } = await supabase.from("tenants").select("state_code").eq("id", me.tenant_id).single();
      return t?.state_code ?? null;
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** The project quotation linked to a lead — its status decides "accepted → mark Won". */
export function useLeadProject(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_sales", "for-lead", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("project_sales").select("id, title, status, total_amount, accepted_at").eq("id", projectId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Raise a project quotation for a lead — create_project_quote_from_lead links it on
 * leads.project_id and moves the lead to Quote Sent.
 */
export function useCreateProjectQuoteFromLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      leadId: string;
      title: string;
      description: string | null;
      taxable: number;
      gstRate: number;
      interState: boolean;
      milestones: { label: string; total_amount: number; due_date: string | null }[];
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_project_quote_from_lead", {
        p_lead_id: input.leadId,
        p_title: input.title,
        p_description: input.description,
        p_line_items: [{ name: input.title, qty: 1, rate: input.taxable, amount: input.taxable }],
        p_gst_rate: input.gstRate,
        p_inter_state: input.interState,
        p_milestones: input.milestones,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Project quotation bana — Project Sales mein customer link se bhejo");
    },
    onError: (err) => toastError(err, { fallback: "Could not create the project quotation" }),
  });
}

/**
 * The customer a lead's company already is, by name (case-insensitive) — the same match
 * create_project_quote_from_lead makes. Its state decides place of supply, so the rep is
 * not asked for something the app already knows.
 */
export function useCustomerForLead(company: string | null | undefined) {
  const name = (company ?? "").trim();
  return useQuery({
    queryKey: ["customers", "for-lead", name.toLowerCase()],
    enabled: name.length > 0,
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers").select("id, name, state_code, gstin")
        /* Exact name, case-insensitive: % and _ in a company name are escaped, not wildcards. */
        .ilike("name", name.replace(/[%_\\]/g, (c) => "\\" + c)).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });
}
