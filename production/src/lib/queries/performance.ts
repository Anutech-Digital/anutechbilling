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
import { createClient } from "@/lib/supabase/client";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";

/** Point weights — tune to taste. Documented so scores are explainable. */
export const PERF_WEIGHTS = {
  revenuePerRupees: 5000, // +1 pt per ₹5,000 collected
  dealWon: 40, // +40 per lead moved to 'won'
  quoteSent: 5, // +5 per quote raised
  paymentRecorded: 5, // +5 per payment collected
  taskOnTime: 3, // +3 per task completed on/before due
  taskLate: -1, // −1 per task completed after due
};

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
}

/** What each role is PRIMARILY judged on — the scorecard highlights this. */
export function roleFocus(role: string): { label: string; hint: string } {
  switch (role) {
    case "sales":
    case "sales_senior": return { label: "Deals won + revenue", hint: "Leads close karna + paisa laana" };
    case "accountant":   return { label: "Payments collected", hint: "Receivables collect karna" };
    case "support":      return { label: "Tasks on-time", hint: "Tickets/tasks time pe" };
    default:             return { label: "Overall results", hint: "Revenue, deals, tasks — sab" };
  }
}

function monthWindow(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const end = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  return { start, end };
}

/** Per-member outcome scores for a month (period = 'YYYY-MM'). */
export function usePerformance(period: string) {
  const membersQ = useTeamMembers();
  const members = membersQ.data ?? [];

  return useQuery({
    queryKey: ["performance", period, members.map((m) => m.id).join(",")],
    enabled: members.length > 0,
    queryFn: async (): Promise<PerfRow[]> => {
      const supabase = createClient();
      const { start, end } = monthWindow(period);

      const [leadsR, quotesR, paymentsR, tasksR, usersR, attR, actR] = await Promise.all([
        supabase.from("leads").select("owner_id, value, stage, updated_at")
          .eq("stage", "won").gte("updated_at", start).lt("updated_at", end),
        supabase.from("quotes").select("owner_id, created_at")
          .gte("created_at", start).lt("created_at", end),
        supabase.from("payments").select("recorded_by, amount, received_at, status")
          .eq("status", "received").gte("received_at", start).lt("received_at", end),
        supabase.from("tasks").select("owner_id, status, due_at, completed_at")
          .eq("status", "done").gte("completed_at", start).lt("completed_at", end),
        supabase.from("users").select("id, employee_id"),
        supabase.from("attendance").select("employee_id, work_date, check_in")
          .gte("work_date", start).lt("work_date", end),
        supabase.from("activity_log").select("user_id, created_at")
          .gte("created_at", start).lt("created_at", end),
      ]);

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

      const rows: PerfRow[] = members.map((mem) => {
        const dealsWon = (leadsR.data ?? []).filter((l) => l.owner_id === mem.id).length;
        const revenue = (paymentsR.data ?? []).filter((p) => p.recorded_by === mem.id)
          .reduce((s, p) => s + (p.amount ?? 0), 0);
        const paymentsCount = (paymentsR.data ?? []).filter((p) => p.recorded_by === mem.id).length;
        const quotesSent = (quotesR.data ?? []).filter((q) => q.owner_id === mem.id).length;
        const myTasks = (tasksR.data ?? []).filter((t) => t.owner_id === mem.id);
        const tasksOnTime = myTasks.filter((t) => t.completed_at && t.due_at && t.completed_at <= t.due_at).length;
        const tasksLate = myTasks.length - tasksOnTime;

        const revPts = Math.round(revenue / PERF_WEIGHTS.revenuePerRupees);
        const breakdown: PerfBreakdown[] = [
          { label: "Revenue collected", detail: `₹${revenue.toLocaleString("en-IN")}`, points: revPts },
          { label: "Deals won", detail: `${dealsWon}`, points: dealsWon * PERF_WEIGHTS.dealWon },
          { label: "Quotes sent", detail: `${quotesSent}`, points: quotesSent * PERF_WEIGHTS.quoteSent },
          { label: "Payments collected", detail: `${paymentsCount}`, points: paymentsCount * PERF_WEIGHTS.paymentRecorded },
          { label: "Tasks on time", detail: `${tasksOnTime}`, points: tasksOnTime * PERF_WEIGHTS.taskOnTime },
          { label: "Tasks late", detail: `${tasksLate}`, points: tasksLate * PERF_WEIGHTS.taskLate },
        ];
        const score = Math.max(0, breakdown.reduce((s, b) => s + b.points, 0));

        const empId = empOf.get(mem.id);
        const presentDays = empId ? (presentByEmp.get(empId) ?? 0) : 0;
        const activityCount = activityByUser.get(mem.id) ?? 0;

        return {
          userId: mem.id, name: memberLabel(mem), role: mem.role,
          dealsWon, revenue, quotesSent, paymentsCount, tasksOnTime, tasksLate,
          presentDays, activityCount, score, breakdown,
        };
      });

      return rows.sort((a, b) => b.score - a.score);
    },
    staleTime: 30_000,
  });
}
