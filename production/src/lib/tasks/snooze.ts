/**
 * Snooze times for a task — pure, so /tasks, the lead sheet and the deal page agree.
 *
 * R-471 (via R-486) built the /tasks menu: In 1 hour · This evening 6 PM (only before
 * 5 PM) · Tomorrow 10 AM · Monday 10 AM. Every choice is measured from NOW, in IST, and the
 * toast reads "Snoozed to 10 Oct 2026, 10:00 am".
 *
 * R-490: the lead sheet and deal page still used the old "+1 day from the OLD due time"
 * (a task 3 days overdue stayed overdue after a snooze) and toasted "10/10/2026, 3:00:00 pm".
 * `snoozeByMinutes` is their rule now; the format is shared.
 */
import { addDaysISO, formatIstDate, formatIstTime, istDayStartUtc, istParts } from "@/lib/dates/ist";

export interface SnoozeChoice {
  key: "1h" | "evening" | "tomorrow" | "monday";
  label: string;
  at: Date;
}

/** An IST wall-clock time on an IST date, as an instant. */
function istAt(dateISO: string, minutesOfDay: number): Date {
  return new Date(istDayStartUtc(dateISO).getTime() + minutesOfDay * 60_000);
}

/** The menu, for this moment. Pure — `now` is passed in. */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  const p = istParts(now);
  const out: SnoozeChoice[] = [
    { key: "1h", label: "In 1 hour", at: new Date(now.getTime() + 60 * 60_000) },
  ];
  if (p.minutesOfDay < 17 * 60) {
    out.push({ key: "evening", label: "This evening, 6 PM", at: istAt(p.date, 18 * 60) });
  }
  out.push({ key: "tomorrow", label: "Tomorrow, 10 AM", at: istAt(addDaysISO(p.date, 1), 10 * 60) });
  // Next Monday (never today, never tomorrow — that is the row above).
  const dow = new Date(`${p.date}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat, of the IST date
  const toMonday = ((8 - dow) % 7) || 7;
  if (toMonday > 1) {
    out.push({ key: "monday", label: "Monday, 10 AM", at: istAt(addDaysISO(p.date, toMonday), 10 * 60) });
  }
  return out;
}

/** "Snoozed to 10 Oct 2026, 10:00 am" — the app's date format, IST. */
export function snoozedMessage(at: Date | string): string {
  return `Snoozed to ${formatIstDate(at)}, ${formatIstTime(at)}`;
}

/**
 * Push a task by `minutes`, counted from whichever is LATER: its due time or now.
 * A future task moves by exactly that much; an overdue one lands that far from now,
 * so a snooze never leaves it overdue.
 */
export function snoozeByMinutes(dueAt: string | Date | null | undefined, minutes: number, now: Date = new Date()): Date {
  const due = dueAt ? new Date(dueAt).getTime() : NaN;
  const base = Number.isNaN(due) ? now.getTime() : Math.max(due, now.getTime());
  return new Date(base + minutes * 60_000);
}
