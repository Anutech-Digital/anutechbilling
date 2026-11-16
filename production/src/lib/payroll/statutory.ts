/**
 * R-2698 — words and lists the employee form shows about statutory switches (ESI / PF).
 *
 * A switch change on the employee applies to salaries paid FROM NOW ON. Payslips already booked
 * keep the PF / ESI they were booked with (salary_payments is never rewritten by an employee
 * edit) — the form lists those months so the owner sees what stays as it is.
 */
import { rupee } from "@/lib/utils";
import { ESI_WAGE_CEILING } from "./esi";
import { periodLabelShort } from "./period-label";

export interface BookedStatutoryMonth { period: string; pf: number; esi: number }

/** Booked salary months that carry employee PF or ESI, oldest first, one row per month
 *  (a month paid in parts adds up). */
export function bookedStatutoryMonths(rows: readonly { period: string; pf?: number | null; esi?: number | null }[]): BookedStatutoryMonth[] {
  const by = new Map<string, BookedStatutoryMonth>();
  for (const r of rows) {
    const period = r.period.slice(0, 7);
    const cur = by.get(period) ?? { period, pf: 0, esi: 0 };
    cur.pf += Math.max(0, Math.round(r.pf ?? 0));
    cur.esi += Math.max(0, Math.round(r.esi ?? 0));
    by.set(period, cur);
  }
  return [...by.values()].filter((m) => m.pf > 0 || m.esi > 0).sort((a, b) => a.period.localeCompare(b.period));
}

/** Unique booked salary months, oldest first. */
export function bookedSalaryMonths(rows: readonly { period: string }[]): string[] {
  return [...new Set(rows.map((r) => r.period.slice(0, 7)))].sort();
}

/** "Sep 2026, Oct 2026" — or, for more than 6, "8 months (Apr 2025 – Nov 2025)". */
export function monthsText(periods: readonly string[]): string {
  if (periods.length <= 6) return periods.map(periodLabelShort).join(", ");
  return `${periods.length} months (${periodLabelShort(periods[0])} – ${periodLabelShort(periods[periods.length - 1])})`;
}

/** The booked months with their PF / ESI, at most 6 written out ("… and 14 more months"). */
export function bookedStatutoryText(months: readonly BookedStatutoryMonth[]): string {
  const one = (m: BookedStatutoryMonth) =>
    `${periodLabelShort(m.period)} (${[m.pf > 0 ? `PF ${rupee(m.pf)}` : "", m.esi > 0 ? `ESI ${rupee(m.esi)}` : ""].filter(Boolean).join(", ")})`;
  const shown = months.slice(-6).map(one).join("; ");
  return months.length > 6 ? `${shown} and ${months.length - 6} earlier months` : shown;
}

/** What still ties an employee to the books — the same three things tg_employee_delete_guard counts. */
export interface DeleteBlockers { salaryMonths: string[]; projectLabour: number; expenseClaims: number }

export const hasDeleteBlockers = (b: DeleteBlockers) => b.salaryMonths.length > 0 || b.projectLabour > 0 || b.expenseClaims > 0;

/** Why an employee cannot be deleted, and what to do instead. `canExit` = the viewer may Start exit. */
export function deleteBlockMessage(name: string, b: DeleteBlockers, canExit = true): string {
  const parts = [
    b.salaryMonths.length > 0 ? `salary booked for ${monthsText(b.salaryMonths)}` : "",
    b.projectLabour > 0 ? `${b.projectLabour} project labour ${b.projectLabour === 1 ? "entry" : "entries"}` : "",
    b.expenseClaims > 0 ? `${b.expenseClaims} expense ${b.expenseClaims === 1 ? "claim" : "claims"}` : "",
  ].filter(Boolean);
  const how = canExit ? "Use Start exit (or untick Active employee in Edit) instead." : "Untick Active employee in Edit instead.";
  return `${name} has ${parts.join(", ")}, so they can't be deleted — payroll and Form 24Q need those records. ${how}`;
}

/** One line under the ESI switch: the ₹21,000 gross rule applied to this employee's gross. */
export function esiRuleNote(monthlyGross: number): string {
  const g = Math.max(0, Math.round(monthlyGross || 0));
  const rule = `ESI applies only while monthly gross is ${rupee(ESI_WAGE_CEILING)} or less`;
  if (g > ESI_WAGE_CEILING) {
    return `${rule}. This employee's gross is ${rupee(g)} — above ${rupee(ESI_WAGE_CEILING)}, so ESI will be ₹0 `
      + "(unless they were already covered earlier in the same Apr–Sep / Oct–Mar period).";
  }
  return `${rule}${g > 0 ? ` — this employee's gross ${rupee(g)} is within it` : ""}.`;
}
