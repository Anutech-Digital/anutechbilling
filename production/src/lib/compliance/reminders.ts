/**
 * Which statutory reminders should go out today — pure, no I/O.
 *
 * Kept apart from the cron so the decision can be rehearsed against any date
 * without a database or a mail provider. The renewal engine taught this lesson
 * the hard way: its first real send was eleven months away, so an untestable
 * scheduler would have had its first proof of life on the day it emailed real
 * customers.
 */
import type { ComplianceRow } from "./obligations";

/**
 * Days before a due date that earn a reminder.
 *
 * Order is not load-bearing — `reminderStepFor` picks the SMALLEST rung that has
 * been reached, whichever order they are listed in. Written descending only
 * because that is how the ladder reads.
 */
export const REMINDER_LADDER = [15, 7, 3] as const;
export type ReminderStep = (typeof REMINDER_LADDER)[number];

export interface PlannedReminder {
  obligationKey: string;
  periodKey: string;
  /** Which rung of the ladder this is — recorded so a later change to the ladder
   *  cannot re-open reminders already sent. */
  daysBefore: ReminderStep;
  /** Actual days remaining, which may be fewer than daysBefore after a catch-up. */
  daysToDue: number;
  dueDate: string;
  /** For the message body. */
  name: string;
  form?: string;
  authority: string;
  penalty?: string;
  periodLabel: string;
  dataHref?: { href: string; label: string };
}

/**
 * Decide which rung, if any, a row is on today.
 *
 * CATCH-UP, not exact-day matching. A cron that only fired when daysToDue was
 * exactly 15, 7 or 3 would silently skip a rung on any day it did not run — a
 * deploy, an outage, a clock skew — and the operator would never know a reminder
 * was owed. Instead the most urgent rung that has been reached is returned, and
 * the sent-log stops it repeating.
 *
 * Returns null for anything already filed, anything overdue (a reminder for a
 * deadline that has passed is not a reminder, it is a different message and the
 * page already shows it in red), and anything still further out than the first
 * rung.
 */
export function reminderStepFor(row: Pick<ComplianceRow, "status" | "daysToDue">): ReminderStep | null {
  if (row.status === "filed" || row.status === "not_applicable") return null;
  if (row.daysToDue < 0) return null;

  // The MOST URGENT rung reached = the smallest step still ≥ daysToDue.
  //
  // At 7 days out, both the 15 and the 7 rung have been reached; sending the
  // 15-day notice then would tell the owner they have a fortnight when they have
  // a week. Taking the smallest is also what makes catch-up honest: a job that
  // misses several days resumes at the rung that matches reality, not the one it
  // was "supposed" to send.
  let chosen: ReminderStep | null = null;
  for (const step of REMINDER_LADDER) {
    if (row.daysToDue <= step && (chosen === null || step < chosen)) chosen = step;
  }
  return chosen;
}

/**
 * All reminders due today, most urgent first.
 *
 * `alreadySent` answers "has this exact rung already gone out for this period?"
 * — the caller backs it with the reminder log. Without it a daily cron would
 * re-send the same T-7 notice every day for four days running, which is how an
 * operator learns to filter these to a folder they never open.
 */
export function dueReminders(
  rows: ComplianceRow[],
  alreadySent: (obligationKey: string, periodKey: string, daysBefore: number) => boolean,
): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const row of rows) {
    const step = reminderStepFor(row);
    if (step === null) continue;
    if (alreadySent(row.ob.key, row.inst.periodKey, step)) continue;
    out.push({
      obligationKey: row.ob.key,
      periodKey:     row.inst.periodKey,
      daysBefore:    step,
      daysToDue:     row.daysToDue,
      dueDate:       row.inst.dueDate,
      name:          row.ob.name,
      form:          row.ob.form,
      authority:     row.ob.authority,
      penalty:       row.ob.penalty,
      periodLabel:   row.inst.periodLabel,
      dataHref:      row.ob.dataHref,
    });
  }
  return out.sort((a, b) => a.daysToDue - b.daysToDue);
}

/**
 * The email for one reminder.
 *
 * States the penalty. That is the whole reason anyone opens a compliance mail on
 * a Sunday, and leaving it out turns an actionable warning into a newsletter.
 *
 * Includes the in-app link to the numbers when the catalog has one, because the
 * gap between "GSTR-1 is due" and actually filing it is finding the figures.
 */
export function renderReminder(r: PlannedReminder, appUrl: string): { subject: string; body: string } {
  const inDays = r.daysToDue === 0 ? "today" : r.daysToDue === 1 ? "tomorrow" : `in ${r.daysToDue} days`;
  const what = r.form ? `${r.form} (${r.name})` : r.name;
  const link = r.dataHref ? `${appUrl.replace(/\/$/, "")}${r.dataHref.href}` : null;

  return {
    subject: `${r.form ?? r.name} due ${inDays} — ${r.periodLabel}`,
    body:
`${what}
${r.authority} · ${r.periodLabel}

Due: ${r.dueDate} (${inDays})
${r.penalty ? `If late: ${r.penalty}\n` : ""}${link ? `\nThe numbers are here: ${r.dataHref!.label}\n${link}\n` : ""}
Once it's filed, mark it done in ResellerOS so this stops chasing you and the
acknowledgement number is on record for your auditor:
${appUrl.replace(/\/$/, "")}/compliance

Dates are the standard ones and can shift with government extensions — confirm
with your CA.`,
  };
}
