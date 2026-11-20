/* R-2937 — the due words on a /tasks row: "Overdue by 3 days" / "Today 3 pm" / a date.
   Every day boundary is the IST calendar day, whatever zone the browser is in. */
import { describe, it, expect } from "vitest";
import { taskDueWords } from "./task-due-words";

/** An IST wall-clock time as an instant: ist("2026-11-20", "15:00") = 09:30 UTC. */
const ist = (day: string, time = "00:00") => new Date(`${day}T${time}:00+05:30`);
const NOW = ist("2026-11-20", "12:00"); // Friday noon, IST
const open = (due: Date | string | null) => ({ status: "pending", due_at: due instanceof Date ? due.toISOString() : due });

describe("taskDueWords — overdue", () => {
  it("counts whole IST calendar days: the owner's example, 3 days", () => {
    expect(taskDueWords(open(ist("2026-11-17", "21:25")), NOW)).toMatchObject({ text: "Overdue by 3 days", tone: "overdue" });
  });
  it("says '1 day' (singular) for yesterday, even when that is under 24 hours ago", () => {
    expect(taskDueWords(open(ist("2026-11-19", "23:30")), NOW).text).toBe("Overdue by 1 day");
  });
  it("a month-old task counts every day", () => {
    expect(taskDueWords(open(ist("2026-10-19", "21:25")), NOW).text).toBe("Overdue by 32 days");
  });
  it("earlier today: hours, then minutes — never '0 days'", () => {
    expect(taskDueWords(open(ist("2026-11-20", "09:00")), NOW).text).toBe("Overdue by 3 hours");
    expect(taskDueWords(open(ist("2026-11-20", "10:59")), NOW).text).toBe("Overdue by 1 hour");
    expect(taskDueWords(open(ist("2026-11-20", "11:35")), NOW).text).toBe("Overdue by 25 min");
    expect(taskDueWords(open(new Date(NOW.getTime() - 20_000)), NOW).text).toBe("Overdue by 1 min");
  });
  it("less than an hour late is minutes even across midnight — never '1 day' for 3 minutes", () => {
    const justAfterMidnight = ist("2026-11-21", "00:01");
    expect(taskDueWords(open(ist("2026-11-20", "23:58")), justAfterMidnight).text).toBe("Overdue by 3 min");
    // An hour or more late, the calendar day counts again.
    expect(taskDueWords(open(ist("2026-11-20", "22:00")), ist("2026-11-21", "03:00")).text).toBe("Overdue by 1 day");
  });
  it("long overdue: every day is counted (the text the row must have room for)", () => {
    expect(taskDueWords(open(ist("2026-07-23", "12:00")), NOW).text).toBe("Overdue by 120 days");
  });
  it("the IST day decides, not the UTC day: 00:30 IST today is 'hours', not '1 day'", () => {
    // 00:30 IST on the 20th is 19:00 UTC on the 19th.
    expect(taskDueWords(open(ist("2026-11-20", "00:30")), NOW).text).toBe("Overdue by 11 hours");
  });
});

describe("taskDueWords — today and ahead", () => {
  it("today: the time, without ':00' on a full hour", () => {
    expect(taskDueWords(open(ist("2026-11-20", "15:00")), NOW)).toMatchObject({ text: "Today 3 pm", tone: "today" });
    expect(taskDueWords(open(ist("2026-11-20", "15:30")), NOW).text).toBe("Today 3:30 pm");
    expect(taskDueWords(open(ist("2026-11-20", "23:59")), NOW).text).toBe("Today 11:59 pm");
  });
  it("due exactly now is Today, not overdue", () => {
    expect(taskDueWords(open(NOW), NOW)).toMatchObject({ text: "Today 12 pm", tone: "today" });
  });
  it("tomorrow: the word and the time", () => {
    expect(taskDueWords(open(ist("2026-11-21", "10:00")), NOW)).toMatchObject({ text: "Tomorrow 10 am", tone: "upcoming" });
    expect(taskDueWords(open(ist("2026-11-21", "00:05")), NOW).text).toBe("Tomorrow 12:05 am");
  });
  it("later this year: weekday, day and month", () => {
    expect(taskDueWords(open(ist("2026-11-24", "10:00")), NOW)).toMatchObject({ text: "Tue, 24 Nov", tone: "upcoming" });
    expect(taskDueWords(open(ist("2026-12-30", "10:00")), NOW).text).toBe("Wed, 30 Dec");
  });
  it("another year: the year is said", () => {
    expect(taskDueWords(open(ist("2027-01-05", "10:00")), NOW).text).toBe("5 Jan 2027");
  });
});

describe("taskDueWords — done, missing, and the full date", () => {
  it("a done task shows its date only — never 'Overdue'", () => {
    expect(taskDueWords({ status: "done", due_at: ist("2026-11-17", "21:25").toISOString() }, NOW)).toMatchObject({ text: "Tue, 17 Nov", tone: "done" });
    expect(taskDueWords({ status: "done", due_at: ist("2025-11-17", "21:25").toISOString() }, NOW).text).toBe("17 Nov 2025");
  });
  it("no due time, or one that cannot be read: 'No date'", () => {
    expect(taskDueWords(open(null), NOW)).toEqual({ text: "No date", tone: "upcoming", full: "No due date" });
    expect(taskDueWords(open("not-a-date"), NOW).text).toBe("No date");
  });
  it("'full' is the whole date and time in IST (the hover text)", () => {
    expect(taskDueWords(open(ist("2026-10-19", "21:25")), NOW).full).toBe("Due Mon, 19 Oct 2026, 9:25 pm");
    expect(taskDueWords(open(ist("2026-11-20", "15:00")), NOW).full).toBe("Due Fri, 20 Nov 2026, 3:00 pm");
  });
});
