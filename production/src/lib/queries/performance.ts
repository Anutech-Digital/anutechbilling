/**
 * Team performance — OUTCOME-based scoring for performance bonuses.
 *
 * Measures RESULTS the app already captures (not screen-time): deals won,
 * revenue collected, quotes sent, payments recorded, tasks done on time — each
 * attributed to a login user via owner_id / recorded_by. Every metric is real
 * business work; nothing is surveilled. Read-only + owner/manager only.
 *
 * Points are transparent (weights below) so the leaderboard is never a black
 * box — each person can see exactly how to earn more. Tune PERF_WEIGHTS to fit
 * how you actually want to reward the team.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import type { KudosRow } from "@/lib/performance/gamification";
/* R-2965: the numbers AND the rows behind them come from one pure function (kpi-records.ts),
   so a tile and the list it opens can never disagree. Re-exported for existing importers. */
import { buildPerfRows, PERF_WEIGHTS, type PerfRow } from "@/lib/performance/kpi-records";
export { PERF_WEIGHTS };
export type { PerfRow, PerfBreakdown, PerfRecords } from "@/lib/performance/kpi-records";

/**
 * ⚠ KNOWN GAMING VECTOR IN `paymentRecorded`, flagged 13 Aug 2026.
 *
 * It pays per payment ROW, and staff choose how to record a collection:
 *
 *     one payment of ₹1,00,000        →  5 + (100000/5000) = 25 pts
 *     the same ₹1,00,000 as 10 × ₹10k →  50 + 20           = 70 pts
 *
 * Same rupees, 2.8× the score — and score splits a cash bonus pool. Setting
 * `paymentRecorded: 0` closes it at no other cost, because `revenuePerRupees`
 * already rewards collecting. Left as-is because the weights are Pardeep's call.
 */

export type PerfScope = "month" | "week";

/** Notes the UI must show rather than silently scoring a tier as zero. */
export interface PerfNote { title: string; detail: string }

/** What each role is PRIMARILY judged on — the scorecard highlights this. */
export function roleFocus(role: string): { label: string; hint: string } {
  switch (role) {
    case "sales":
    case "sales_senior": return { label: "Deals won + revenue", hint: "Closing leads + bringing in revenue" };
    case "accountant":   return { label: "Payments collected", hint: "Collecting receivables" };
    case "support":      return { label: "Tasks on-time", hint: "Tickets/tasks on time" };
    default:             return { label: "Overall results", hint: "Revenue, deals, tasks — all of it" };
  }
}

/* R-2965 note: these are bare dates, which Postgres reads as UTC midnight against the
   timestamptz columns — so the month runs 05:30 IST on the 1st to 05:30 IST on the next 1st
   (follow-up card filed). The Sheets read the same window, so they always match the tiles. */
export function monthWindow(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const end = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  return { start, end };
}

/**
 * The current Monday-to-Monday week, in IST.
 *
 * A weekly board is always "this week" — the month picker does not narrow it,
 * because a month contains four or five weeks and there is no sensible single
 * answer to "which week of August". IST has no DST, so a fixed +5:30 is exact.
 */
export function weekWindow(now: Date = new Date()): { start: string; end: string } {
  const IST_MS = 5.5 * 3_600_000;
  const ist = new Date(now.getTime() + IST_MS);
  const dow = (ist.getUTCDay() + 6) % 7;              // 0 = Monday
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - dow);
  const next = new Date(monday);
  next.setUTCDate(next.getUTCDate() + 7);
  // Back to real instants before comparing against timestamptz columns.
  return {
    start: new Date(monday.getTime() - IST_MS).toISOString(),
    end:   new Date(next.getTime()   - IST_MS).toISOString(),
  };
}

/** A paged read as `{ data, error }` — for the one read whose error is an answer (kudos before 0231). */
async function settle<T>(read: Promise<T[]>): Promise<{ data: T[] | null; error: unknown }> {
  try { return { data: await read, error: null }; } catch (error) { return { data: null, error }; }
}

/**
 * R-1588: every row behind the scores, paged past the gateway's 1000-row cap. A busy month
 * has well over 1000 activity_log rows; read in one request, the activity count (and every
 * other count here) silently stopped at the first 1000. Each read ends its order on `id`.
 */
export async function fetchPerformanceInputs(supabase: SupabaseClient<Database>, start: string, end: string) {
  const [leads, quotes, payments, tasks, users, att, act, kudosR] = await Promise.all([
    fetchAllRows((from, to) => supabase.from("leads").select("id, owner_id, value, stage, updated_at, stage_changed_at, company, contact_name")
      .eq("stage", "won").gte("updated_at", start).lt("updated_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("quotes").select("id, owner_id, created_at, customer_name, amount, status, is_renewal")
      .gte("created_at", start).lt("created_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("payments").select("id, recorded_by, amount, received_at, status, quote_id, invoice_id, customer_id, method, reference")
      .eq("status", "received").gte("received_at", start).lt("received_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("tasks").select("id, owner_id, status, due_at, completed_at, title")
      .eq("is_goal", false) // R-2957: points are for the sub-tasks, never for the goal row too
      .eq("status", "done").gte("completed_at", start).lt("completed_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("users").select("id, employee_id")
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("attendance").select("id, employee_id, work_date, check_in")
      .gte("work_date", start).lt("work_date", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("activity_log").select("user_id, created_at, action, entity")
      .gte("created_at", start).lt("created_at", end)
      .order("id", { ascending: true }).range(from, to)),
    // Peer kudos. Arrives with migration 0231 — before that this errors, so
    // the result is checked rather than spread, and the page still renders.
    settle(fetchAllRows((from, to) => supabase.from("task_kudos").select("user_id, awarded_by, created_at")
      .gte("created_at", start).lt("created_at", end)
      .order("id", { ascending: true }).range(from, to))),
  ]);
  // Renewal quotes for the Renewal Guardian badge. Looked up by the quotes this period's
  // payments settle, NOT by date: a payment inside this week can settle a quote raised
  // months ago. Only membership is read, so this is the same answer as "every renewal
  // quote" — without reading (and being cut at 1000 of) all of them.
  const renewalQuotes = await fetchAllRowsIn(payments.map((p) => p.quote_id), (ids, from, to) =>
    supabase.from("quotes").select("id").eq("is_renewal", true).in("id", ids)
      .order("id", { ascending: true }).range(from, to));
  return {
    leadsR: { data: leads }, quotesR: { data: quotes }, paymentsR: { data: payments },
    tasksR: { data: tasks }, usersR: { data: users }, attR: { data: att }, actR: { data: act },
    kudosR, renewalQuotesR: { data: renewalQuotes },
  };
}

/**
 * Per-member outcome scores.
 *
 * @param period 'YYYY-MM' — used when scope is 'month'.
 * @param scope  'month' (default, unchanged behaviour) or 'week' (this week).
 * @param opts   `enabled: false` reads nothing (R-2725: the Employees table asks only for
 *               owner / manager — the roles that may open Scorecards).
 */
export function usePerformance(period: string, scope: PerfScope = "month", opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled !== false;
  const membersQ = useTeamMembers();
  const members = membersQ.data ?? [];

  const q = useQuery({
    queryKey: ["performance", period, scope, members.map((m) => m.id).join(",")],
    enabled: enabled && members.length > 0,
    queryFn: async (): Promise<PerfRow[]> => {
      const supabase = createClient();
      const { start, end } = scope === "week" ? weekWindow() : monthWindow(period);

      const { leadsR, quotesR, paymentsR, tasksR, usersR, attR, actR, kudosR, renewalQuotesR } =
        await fetchPerformanceInputs(supabase, start, end);

      // Kudos: `kudosR.error` means 0231 is not applied yet; an empty tally is the honest
      // answer, not a crash.
      const kudos: KudosRow[] = kudosR.error
        ? []
        : (kudosR.data ?? []).map((r) => ({ userId: r.user_id, awardedBy: r.awarded_by, createdAt: r.created_at }));

      /* R-2965: every number on a scorecard is the count / sum of the rows kept in
         `records` — the lists the KPI Sheets show. */
      return buildPerfRows(
        members.map((mem) => ({ id: mem.id, name: memberLabel(mem), role: mem.role })),
        {
          leads: leadsR.data ?? [], quotes: quotesR.data ?? [], payments: paymentsR.data ?? [],
          tasks: tasksR.data ?? [], users: usersR.data ?? [], attendance: attR.data ?? [],
          activity: actR.data ?? [], kudos,
          renewalQuoteIds: new Set((renewalQuotesR.data ?? []).map((q) => q.id)),
        },
      );
    },
    staleTime: 30_000,
  });

  /* R-1807: the scores wait on the team list. While that list loads, or when it FAILS, the
     score query is disabled — neither loading nor an error — so the pages said "No team
     members yet". Both states are carried here; Try again re-reads whichever failed. */
  return {
    data: q.data,
    isLoading: enabled && (membersQ.isLoading || q.isLoading),
    isError: enabled && (membersQ.isError || q.isError),
    error: membersQ.isError ? membersQ.error : q.error,
    refetch: () => {
      if (membersQ.isError) void membersQ.refetch();
      else void q.refetch();
    },
  };
}
