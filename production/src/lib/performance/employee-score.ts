/**
 * R-2725 — the Score on the Employees table and the Scorecard link on an employee's profile.
 *
 * The score itself is NOT computed here: it is `PerfRow.score` from `usePerformance`
 * (lib/queries/performance.ts) — the same rows the Scorecards page shows. A score belongs to a
 * LOGIN (users row); an employee has one only through the login linked to them
 * (users.employee_id, "Logins for attendance"). This file only maps employee → that row.
 */
import { istMonth } from "@/lib/dates/ist";

/** The part of a PerfRow this needs. */
export interface ScoreRow { userId: string; employeeId?: string | null; score: number }

export interface EmployeeScore { userId: string; score: number }

/** The month both the Employees table and the Scorecards page open on (IST) — one period,
 *  so the two always show the same number. */
export function scorePeriodNow(now: Date = new Date()): string {
  return istMonth(now);
}

/** employee id → the score of the login linked to that employee. An employee with no linked
 *  (active) login is absent. Two logins on one employee (the app allows one) → the first row
 *  wins, and rows arrive highest score first. */
export function scoresByEmployee(rows: readonly ScoreRow[] | null | undefined): Map<string, EmployeeScore> {
  const out = new Map<string, EmployeeScore>();
  for (const r of rows ?? []) {
    if (!r.employeeId || out.has(r.employeeId)) continue;
    out.set(r.employeeId, { userId: r.userId, score: r.score });
  }
  return out;
}

/** That person's scorecard: the Scorecards page narrowed to one login. */
export function scorecardHref(userId: string): string {
  return `/scorecard?user=${encodeURIComponent(userId)}`;
}

export type ScoreSort = "desc" | "asc" | null;

/** Header click: list order → highest first → lowest first → list order. */
export function nextScoreSort(sort: ScoreSort): ScoreSort {
  return sort === null ? "desc" : sort === "desc" ? "asc" : null;
}

/** Employees ordered by score; people with no score stay last either way, in list order.
 *  `null` returns the list as it came. Never mutates. */
export function sortEmployeesByScore<T extends { id: string }>(
  employees: readonly T[], scores: ReadonlyMap<string, EmployeeScore>, sort: ScoreSort,
): T[] {
  if (sort === null) return [...employees];
  const scored = employees.filter((e) => scores.has(e.id));
  const rest = employees.filter((e) => !scores.has(e.id));
  const sign = sort === "desc" ? -1 : 1;
  scored.sort((a, b) => sign * (scores.get(a.id)!.score - scores.get(b.id)!.score));
  return [...scored, ...rest];
}
