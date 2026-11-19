import { describe, it, expect } from "vitest";
import {
  weekStart, lastWeeks, teamWorkload, weeklyTrend, reportRangeStartUtc, mergeById, TREND_WEEKS, type ReportTask,
} from "./team-tasks";

/* R-2932 — Reports → Team tasks: who has how much work, who is behind, and the 8-week trend.
   Days and weeks are IST (Monday → Sunday). */

const now = new Date("2026-11-18T06:30:00Z"); // Wednesday 18 Nov 2026, 12:00 IST

let n = 0;
const task = (owner_id: string | null, status: ReportTask["status"], due_at: string, completed_at: string | null = null): ReportTask =>
  ({ id: `t${++n}`, owner_id, status, due_at, completed_at });

const members = [
  { id: "amit", full_name: "Amit Shah", email: "amit@example.com" },
  { id: "bina", full_name: null, email: "bina@example.com" },
  { id: "chirag", full_name: "Chirag Rao", email: null },
];

describe("R-2932 weeks are IST, Monday first", () => {
  it("finds the Monday of a day's week", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-16"); // Wed
    expect(weekStart("2026-11-16")).toBe("2026-11-16"); // Mon
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // Sun
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // Sun, month edge
  });

  it("lists the last 8 weeks, oldest first, this week last", () => {
    const weeks = lastWeeks("2026-11-18");
    expect(TREND_WEEKS).toBe(8);
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toEqual({ start: "2026-09-28", end: "2026-10-04", label: "28 Sep" });
    expect(weeks[7]).toEqual({ start: "2026-11-16", end: "2026-11-22", label: "16 Nov" });
  });

  it("reads from IST midnight of the first week's Monday", () => {
    expect(reportRangeStartUtc(now)).toBe("2026-09-27T18:30:00.000Z");
  });
});

describe("R-2932 workload per person", () => {
  const tasks = [
    task("amit", "pending", "2026-11-20T06:00:00Z"),                          // open, not due yet
    task("amit", "snoozed", "2026-11-10T06:00:00Z"),                          // open + overdue
    task("amit", "pending", "2026-11-18T05:00:00Z"),                          // open + overdue (earlier today)
    task("amit", "done", "2026-11-17T06:00:00Z", "2026-11-17T05:00:00Z"),     // done this week (Tue)
    task("amit", "done", "2026-11-12T06:00:00Z", "2026-11-15T17:00:00Z"),     // done Sun 22:30 IST = LAST week
    task("amit", "cancelled", "2026-11-01T06:00:00Z"),                        // never counted
    task("bina", "done", "2026-11-10T06:00:00Z", "2026-11-15T18:40:00Z"),     // Mon 00:10 IST = this week
    task(null, "pending", "2026-11-01T06:00:00Z"),                            // nobody's — overdue
    task("gone-user", "pending", "2026-11-25T06:00:00Z"),                     // owner no longer in the team
  ];
  const rows = teamWorkload(tasks, members, now);

  it("counts open, overdue and done-this-week for each member", () => {
    expect(rows.find((r) => r.id === "amit")).toEqual({ id: "amit", name: "Amit Shah", open: 3, overdue: 2, doneThisWeek: 1 });
    expect(rows.find((r) => r.id === "bina")).toEqual({ id: "bina", name: "bina", open: 0, overdue: 0, doneThisWeek: 1 });
  });

  it("keeps a member with no tasks on the list (0 / 0 / 0)", () => {
    expect(rows.find((r) => r.id === "chirag")).toEqual({ id: "chirag", name: "Chirag Rao", open: 0, overdue: 0, doneThisWeek: 0 });
  });

  it("puts unassigned tasks and tasks of people no longer in the team in one last row", () => {
    expect(rows.at(-1)).toEqual({ id: null, name: "Unassigned", open: 2, overdue: 1, doneThisWeek: 0 });
  });

  it("has no Unassigned row when every task has a current owner", () => {
    expect(teamWorkload(tasks.filter((t) => t.owner_id === "amit"), members, now).some((r) => r.id === null)).toBe(false);
  });

  it("lists who is furthest behind first: most overdue, then most open, then name", () => {
    expect(rows.map((r) => r.id)).toEqual(["amit", "bina", "chirag", null]);
    const tie = teamWorkload([task("chirag", "pending", "2026-11-25T06:00:00Z")], members, now);
    expect(tie.map((r) => r.id)).toEqual(["chirag", "amit", "bina"]);
  });
});

describe("R-2932 8-week trend — completed vs late", () => {
  it("counts a task as completed in the IST week it was ticked", () => {
    const trend = weeklyTrend([
      task("amit", "done", "2026-11-05T06:00:00Z", "2026-11-15T17:00:00Z"),   // Sun 22:30 IST → week of 9 Nov
      task("amit", "done", "2026-11-05T06:00:00Z", "2026-11-15T18:40:00Z"),   // Mon 00:10 IST → week of 16 Nov
    ], now);
    expect(trend.find((w) => w.start === "2026-11-09")!.completed).toBe(1);
    expect(trend.find((w) => w.start === "2026-11-16")!.completed).toBe(1);
  });

  it("counts a task as late in the week it was DUE: still open past its time, or ticked after it", () => {
    const trend = weeklyTrend([
      task("amit", "pending", "2026-11-11T06:00:00Z"),                         // due last week, still open → late
      task("amit", "done", "2026-11-12T06:00:00Z", "2026-11-17T06:00:00Z"),    // due last week, done this week → late (last week) + completed (this week)
      task("amit", "done", "2026-11-13T06:00:00Z", "2026-11-13T05:00:00Z"),    // done in time → not late
      task("amit", "pending", "2026-11-20T06:00:00Z"),                         // due later this week → not late yet
      task("amit", "pending", "2026-11-18T05:00:00Z"),                         // due earlier today → late (this week)
      task("amit", "cancelled", "2026-11-11T06:00:00Z"),                       // never counted
    ], now);
    const last = trend.find((w) => w.start === "2026-11-09")!;
    const cur = trend.find((w) => w.start === "2026-11-16")!;
    expect({ completed: last.completed, late: last.late }).toEqual({ completed: 1, late: 2 });
    expect({ completed: cur.completed, late: cur.late }).toEqual({ completed: 1, late: 1 });
  });

  it("always returns 8 weeks, zeros included, and ignores anything older", () => {
    const trend = weeklyTrend([task("amit", "done", "2026-08-01T06:00:00Z", "2026-08-02T06:00:00Z")], now);
    expect(trend).toHaveLength(8);
    expect(trend.every((w) => w.completed === 0 && w.late === 0)).toBe(true);
    expect(trend.map((w) => w.label)).toEqual(["28 Sep", "5 Oct", "12 Oct", "19 Oct", "26 Oct", "2 Nov", "9 Nov", "16 Nov"]);
  });
});

describe("R-2932 the three reads overlap", () => {
  it("keeps each task once", () => {
    const a = task("amit", "done", "2026-11-12T06:00:00Z", "2026-11-12T05:00:00Z");
    const b = task("amit", "pending", "2026-11-12T06:00:00Z");
    expect(mergeById([b], [a], [a])).toEqual([b, a]);
  });
});
