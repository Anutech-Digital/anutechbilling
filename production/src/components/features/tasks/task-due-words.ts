/**
 * R-2937 — the due column of a /tasks row, in words: "Overdue by 3 days" / "Today 3 pm" /
 * "Tomorrow 10 am" / "Tue, 24 Nov". The row used to print "Mon, 19 Oct, 09:25 pm" and leave
 * the reader to work out how late that is.
 *
 * Plain function. Every day boundary is the IST calendar day (lib/dates/ist), like the list's
 * groups (task-groups.ts): a task is overdue the minute its time passes, and "by N days" counts
 * IST days — due yesterday 11:30 pm is "1 day" at noon today. Less than an hour late is always
 * minutes, so a task due 11:58 pm does not read "1 day" at 12:01 am.
 */
import { IST_TZ, daysBetweenISO, toIstDate } from "@/lib/dates/ist";

export type TaskDueTone = "overdue" | "today" | "upcoming" | "done";

export interface TaskDueWords {
  /** What the row shows. */
  text: string;
  tone: TaskDueTone;
  /** The whole date and time (IST) — the hover text and the opened row. */
  full: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: IST_TZ, hour: "numeric", minute: "2-digit", hour12: true });

/** "3:30 pm" (IST). */
function clock(at: Date): string {
  return TIME_FMT.format(at).toLowerCase().replace(/\s+/g, " ");
}
/** "3 pm" on a full hour, else "3:30 pm". */
function shortClock(at: Date): string {
  return clock(at).replace(":00", "");
}
/** Built from the IST date's own numbers, so no browser zone or locale can move it. */
function dayParts(isoDay: string): { weekday: string; day: number; month: string; year: string } {
  return {
    weekday: WEEKDAYS[new Date(`${isoDay}T00:00:00Z`).getUTCDay()],
    day: Number(isoDay.slice(8, 10)),
    month: MONTHS[Number(isoDay.slice(5, 7)) - 1],
    year: isoDay.slice(0, 4),
  };
}
/** "Tue, 24 Nov" in the year we are in; "5 Jan 2027" in any other. */
function shortDay(isoDay: string, today: string): string {
  const p = dayParts(isoDay);
  return p.year === today.slice(0, 4) ? `${p.weekday}, ${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function taskDueWords(
  task: { status: string; due_at: string | null | undefined },
  now: Date = new Date(),
): TaskDueWords {
  const due = task.due_at ? new Date(task.due_at) : null;
  if (!due || Number.isNaN(due.getTime())) return { text: "No date", tone: "upcoming", full: "No due date" };

  const day = toIstDate(due);
  const today = toIstDate(now);
  const p = dayParts(day);
  const full = `Due ${p.weekday}, ${p.day} ${p.month} ${p.year}, ${clock(due)}`;

  if (task.status === "done") return { text: shortDay(day, today), tone: "done", full };

  if (due.getTime() < now.getTime()) {
    const minutes = Math.max(1, Math.floor((now.getTime() - due.getTime()) / 60_000));
    if (minutes < 60) return { text: `Overdue by ${minutes} min`, tone: "overdue", full };
    const days = daysBetweenISO(day, today);
    return {
      text: days >= 1 ? `Overdue by ${plural(days, "day")}` : `Overdue by ${plural(Math.floor(minutes / 60), "hour")}`,
      tone: "overdue",
      full,
    };
  }

  const ahead = daysBetweenISO(today, day);
  if (ahead <= 0) return { text: `Today ${shortClock(due)}`, tone: "today", full };
  if (ahead === 1) return { text: `Tomorrow ${shortClock(due)}`, tone: "upcoming", full };
  return { text: shortDay(day, today), tone: "upcoming", full };
}
