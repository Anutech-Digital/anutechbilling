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
import {
  tallyKudos, badgesFor, type BadgeDef, type KudosRow,
} from "@/lib/performance/gamification";

/** Point weights — tune to taste. Documented so scores are explainable. */
export const PERF_WEIGHTS = {
  revenuePerRupees: 5000, // +1 pt per ₹5,000 collected
  dealWon: 40, // +40 per lead moved to 'won'
  quoteSent: 5, // +5 per quote raised
  paymentRecorded: 5, // +5 per payment collected
  taskOnTime: 3, // +3 per task completed on/before due
  taskLate: -1, // −1 per task completed after due
  kudosReceived: 10, // +10 per peer kudos (budgeted — see gamification.ts)
};

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

export interface PerfBreakdown { label: string; detail: string; points: number }
export interface PerfRow {
  userId: string;
  name: string;
  role: string;
  dealsWon: number;
  revenue: number;
  quotesSent: number;
  paymentsCount: number;
  tasksOnTime: number;
  tasksLate: number;
  presentDays: number;   // reliability (attendance) — this month
  activityCount: number; // leading signal (activity log) — this month
  score: number;
  breakdown: PerfBreakdown[];
  // ── Gamification (added 13 Aug 2026). Optional so existing consumers of
  //    PerfRow — /scorecard — keep compiling untouched.
  kudosReceived?: number;
  distinctKudosGivers?: number;
  renewalPayments?: number;
  badges?: BadgeDef[];
}

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

function monthWindow(period: string): { start: string; end: string } {
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
    fetchAllRows((from, to) => supabase.from("leads").select("owner_id, value, stage, updated_at")
      .eq("stage", "won").gte("updated_at", start).lt("updated_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("quotes").select("owner_id, created_at")
      .gte("created_at", start).lt("created_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("payments").select("recorded_by, amount, received_at, status, quote_id")
      .eq("status", "received").gte("received_at", start).lt("received_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("tasks").select("owner_id, status, due_at, completed_at")
      .eq("status", "done").gte("completed_at", start).lt("completed_at", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("users").select("id, employee_id")
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("attendance").select("employee_id, work_date, check_in")
      .gte("work_date", start).lt("work_date", end)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("activity_log").select("user_id, created_at")
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
 */
export function usePerformance(period: string, scope: PerfScope = "month") {
  const membersQ = useTeamMembers();
  const members = membersQ.data ?? [];

  const q = useQuery({
    queryKey: ["performance", period, scope, members.map((m) => m.id).join(",")],
    enabled: members.length > 0,
    queryFn: async (): Promise<PerfRow[]> => {
      const supabase = createClient();
      const { start, end } = scope === "week" ? weekWindow() : monthWindow(period);

      const { leadsR, quotesR, paymentsR, tasksR, usersR, attR, actR, kudosR, renewalQuotesR } =
        await fetchPerformanceInputs(supabase, start, end);

      // user → employee, then present-days per user (reliability).
      const empOf = new Map<string, string | null>((usersR.data ?? []).map((u) => [u.id, u.employee_id]));
      const presentByEmp = new Map<string, number>();
      for (const a of attR.data ?? []) {
        if (a.check_in && a.employee_id) presentByEmp.set(a.employee_id, (presentByEmp.get(a.employee_id) ?? 0) + 1);
      }
      const activityByUser = new Map<string, number>();
      for (const a of actR.data ?? []) {
        if (a.user_id) activityByUser.set(a.user_id, (activityByUser.get(a.user_id) ?? 0) + 1);
      }

      // Kudos, with the per-giver budget applied. `kudosR.error` means 0231 is
      // not applied yet; an empty tally is the honest answer, not a crash.
      const kudosRows: KudosRow[] = kudosR.error
        ? []
        : (kudosR.data ?? []).map((r) => ({
            userId: r.user_id, awardedBy: r.awarded_by, createdAt: r.created_at,
          }));
      const kudos = tallyKudos(kudosRows);

      const renewalQuoteIds = new Set((renewalQuotesR.data ?? []).map((q) => q.id));

      const rows: PerfRow[] = members.map((mem) => {
        const dealsWon = (leadsR.data ?? []).filter((l) => l.owner_id === mem.id).length;
        const revenue = (paymentsR.data ?? []).filter((p) => p.recorded_by === mem.id)
          .reduce((s, p) => s + (p.amount ?? 0), 0);
        const paymentsCount = (paymentsR.data ?? []).filter((p) => p.recorded_by === mem.id).length;
        const quotesSent = (quotesR.data ?? []).filter((q) => q.owner_id === mem.id).length;
        const myTasks = (tasksR.data ?? []).filter((t) => t.owner_id === mem.id);
        const tasksOnTime = myTasks.filter((t) => t.completed_at && t.due_at && t.completed_at <= t.due_at).length;
        const tasksLate = myTasks.length - tasksOnTime;

        const renewalPayments = (paymentsR.data ?? [])
          .filter((p) => p.recorded_by === mem.id && p.quote_id && renewalQuoteIds.has(p.quote_id)).length;

        const myKudos = kudos.byUser[mem.id] ?? { points: 0, received: 0, distinctGivers: 0 };

        const revPts = Math.round(revenue / PERF_WEIGHTS.revenuePerRupees);
        const breakdown: PerfBreakdown[] = [
          { label: "Revenue collected", detail: `₹${revenue.toLocaleString("en-IN")}`, points: revPts },
          { label: "Deals won", detail: `${dealsWon}`, points: dealsWon * PERF_WEIGHTS.dealWon },
          { label: "Quotes sent", detail: `${quotesSent}`, points: quotesSent * PERF_WEIGHTS.quoteSent },
          { label: "Payments collected", detail: `${paymentsCount}`, points: paymentsCount * PERF_WEIGHTS.paymentRecorded },
          { label: "Tasks on time", detail: `${tasksOnTime}`, points: tasksOnTime * PERF_WEIGHTS.taskOnTime },
          { label: "Tasks late", detail: `${tasksLate}`, points: tasksLate * PERF_WEIGHTS.taskLate },
        ];
        // Only shown once kudos exist, so the breakdown does not carry a
        // permanent "Peer kudos 0" line on a workspace that has none yet.
        if (myKudos.received > 0) {
          breakdown.push({
            label: "Peer kudos",
            detail: `${myKudos.received} from ${myKudos.distinctGivers} ${myKudos.distinctGivers === 1 ? "person" : "people"}`,
            points: myKudos.points,
          });
        }
        const score = Math.max(0, breakdown.reduce((s, b) => s + b.points, 0));

        const empId = empOf.get(mem.id);
        const presentDays = empId ? (presentByEmp.get(empId) ?? 0) : 0;
        const activityCount = activityByUser.get(mem.id) ?? 0;

        return {
          userId: mem.id, name: memberLabel(mem), role: mem.role,
          dealsWon, revenue, quotesSent, paymentsCount, tasksOnTime, tasksLate,
          presentDays, activityCount, score, breakdown,
          kudosReceived: myKudos.received,
          distinctKudosGivers: myKudos.distinctGivers,
          renewalPayments,
          badges: badgesFor({
            score,
            tasksOnTime,
            renewalPayments,
            kudosReceived: myKudos.received,
            distinctKudosGivers: myKudos.distinctGivers,
          }),
        };
      });

      return rows.sort((a, b) => b.score - a.score);
    },
    staleTime: 30_000,
  });

  /* R-1807: the scores wait on the team list. While that list loads, or when it FAILS, the
     score query is disabled — neither loading nor an error — so the pages said "No team
     members yet". Both states are carried here; Try again re-reads whichever failed. */
  return {
    data: q.data,
    isLoading: membersQ.isLoading || q.isLoading,
    isError: membersQ.isError || q.isError,
    error: membersQ.isError ? membersQ.error : q.error,
    refetch: () => {
      if (membersQ.isError) void membersQ.refetch();
      else void q.refetch();
    },
  };
}
