import { describe, it, expect } from "vitest";
import { PAGE_CHOICES } from "@/lib/navigation/drilldown";
import { taskSummary } from "@/components/features/tasks/task-overview";
import { groupTasks, taskTabCounts } from "@/components/features/tasks/task-groups";
import {
  dueStrip, newlyAddedTasks, prioritySlices, statusSlices, taskHref, tasksTabHref, upcomingTasks, sliceShare,
} from "./overview-counts";

/* R-2936 — /tasks/overview: every number is counted from the same groups the Tasks list shows. */

type T = {
  id: string; title: string; status: "pending" | "snoozed" | "done" | "cancelled";
  due_at: string | null; completed_at?: string | null; created_at: string;
  priority?: string | null; progress?: string | null;
};
let n = 0;
const task = (over: Partial<T> = {}): T => ({
  id: `t${++n}`, title: `Task ${n}`, status: "pending", due_at: null, created_at: "2026-11-01T06:30:00Z", ...over,
});

/** Thursday 19 Nov 2026, 12:00 IST. The week runs Mon 16 → Sun 22; the month ends on the 30th. */
const NOW = new Date("2026-11-19T06:30:00Z");

describe("R-2936 status donut — open tasks by the step a person set (R-2927)", () => {
  it("counts Not started / In progress / On hold; done and cancelled tasks are not open", () => {
    const slices = statusSlices([
      task(), task({ progress: "not_started" }), task({ progress: "in_progress" }),
      task({ progress: "on_hold", status: "snoozed" }), task({ progress: "nonsense" }),
      task({ status: "done", progress: "in_progress" }), task({ status: "cancelled" }),
    ], NOW);
    expect(slices.map((s) => [s.id, s.label, s.count])).toEqual([
      ["not_started", "Not started", 3], ["in_progress", "In progress", 1], ["on_hold", "On hold", 1],
    ]);
  });

  it("adds up to the Open card", () => {
    const tasks = [task(), task({ progress: "in_progress" }), task({ status: "done", completed_at: "2026-11-18T06:30:00Z" }), task({ status: "cancelled" })];
    const total = statusSlices(tasks, NOW).reduce((s, x) => s + x.count, 0);
    expect(total).toBe(taskSummary(tasks, NOW).open);
    expect(prioritySlices(tasks, NOW).reduce((s, x) => s + x.count, 0)).toBe(total);
  });
});

describe("R-2936 priority donut — open tasks by priority (R-2926)", () => {
  it("High first; a task with no priority reads as Medium", () => {
    const slices = prioritySlices([
      task({ priority: "high" }), task({ priority: "high" }), task({ priority: "low" }), task(), task({ priority: null }),
      task({ priority: "high", status: "done" }),
    ], NOW);
    expect(slices.map((s) => [s.id, s.label, s.count])).toEqual([["high", "High", 2], ["medium", "Medium", 2], ["low", "Low", 1]]);
  });
});

describe("R-2936 share of a slice", () => {
  it("whole percent; 0 when nothing is open", () => {
    expect(sliceShare(1, 3)).toBe(33);
    expect(sliceShare(3, 3)).toBe(100);
    expect(sliceShare(0, 0)).toBe(0);
  });
});

describe("R-2936 due strip — Overdue / Today / This week / This month", () => {
  const tasks = [
    task({ due_at: "2026-11-10T06:30:00Z" }),                    // overdue (last week)
    task({ due_at: "2026-11-19T05:00:00Z" }),                    // overdue — earlier today (R-471)
    task({ due_at: "2026-11-19T10:00:00Z" }),                    // today, 3:30 pm IST
    task({ due_at: "2026-11-19T18:40:00Z" }),                    // Fri 20 Nov 00:10 IST → this week
    task({ due_at: "2026-11-22T18:00:00Z" }),                    // Sun 22 Nov 23:30 IST → this week
    task({ due_at: "2026-11-22T18:40:00Z" }),                    // Mon 23 Nov 00:10 IST → this month only
    task({ due_at: "2026-11-30T18:00:00Z" }),                    // 30 Nov 23:30 IST → this month
    task({ due_at: "2026-11-30T18:40:00Z" }),                    // 1 Dec 00:10 IST → neither
    task({ due_at: null }),                                      // no date
    task({ due_at: "2026-11-20T06:30:00Z", status: "done" }),    // done — never counted
    task({ due_at: "2026-11-20T06:30:00Z", status: "cancelled" }),
  ];

  it("counts open tasks by IST day; This week and This month are what is still ahead, today included", () => {
    expect(dueStrip(tasks, NOW)).toEqual({
      overdue: 2, today: 1, thisWeek: 3, thisMonth: 5, weekEnd: "2026-11-22", monthEnd: "2026-11-30",
    });
  });

  it("Overdue and Today equal the Tasks page's tabs; the rest is inside its Today + Upcoming tabs", () => {
    const strip = dueStrip(tasks, NOW);
    const tabs = taskTabCounts(groupTasks(tasks, NOW));
    expect(strip.overdue).toBe(tabs.overdue);
    expect(strip.today).toBe(tabs.today);
    expect(strip.thisWeek).toBeLessThanOrEqual(tabs.today + tabs.upcoming);
    expect(strip.thisMonth).toBeLessThanOrEqual(tabs.today + tabs.upcoming);
    expect(strip.thisWeek).toBeGreaterThanOrEqual(strip.today);
  });

  it("on a Sunday, This week is what is left of today — not a blank 0", () => {
    const sun = new Date("2026-11-22T06:30:00Z");                // Sun 22 Nov 12:00 IST
    const strip = dueStrip([task({ due_at: "2026-11-22T10:00:00Z" }), task({ due_at: "2026-11-23T06:30:00Z" }), task({ due_at: "2026-11-22T05:00:00Z" })], sun);
    expect(strip).toMatchObject({ overdue: 1, today: 1, thisWeek: 1, thisMonth: 2, weekEnd: "2026-11-22" });
  });

  it("a week that runs into next month: This week can hold more than This month", () => {
    const sat = new Date("2026-11-28T06:30:00Z");                // Sat 28 Nov; week ends Sun 29, month ends Mon 30
    const strip = dueStrip([task({ due_at: "2026-11-29T06:30:00Z" }), task({ due_at: "2026-11-30T06:30:00Z" })], sat);
    expect(strip).toMatchObject({ thisWeek: 1, thisMonth: 2, weekEnd: "2026-11-29", monthEnd: "2026-11-30" });
    const mon = new Date("2026-11-30T06:30:00Z");                // Mon 30 Nov; week ends Sun 6 Dec
    expect(dueStrip([task({ due_at: "2026-12-02T06:30:00Z" })], mon)).toMatchObject({ thisWeek: 1, thisMonth: 0, weekEnd: "2026-12-06" });
  });
});

describe("R-2936 Upcoming 5", () => {
  it("the next open tasks still ahead, soonest first — never overdue, done or undated ones", () => {
    const list = [
      task({ id: "later", due_at: "2026-12-05T06:30:00Z" }),
      task({ id: "overdue", due_at: "2026-11-18T06:30:00Z" }),
      task({ id: "today", due_at: "2026-11-19T10:00:00Z" }),
      task({ id: "nodate" }),
      task({ id: "done", due_at: "2026-11-20T06:30:00Z", status: "done" }),
      task({ id: "tomorrow", due_at: "2026-11-20T06:30:00Z" }),
    ];
    expect(upcomingTasks(list, NOW).map((t) => t.id)).toEqual(["today", "tomorrow", "later"]);
  });

  it("at most five", () => {
    const many = Array.from({ length: 8 }, (_, i) => task({ due_at: `2026-11-2${i}T06:30:00Z` }));
    expect(upcomingTasks(many, NOW)).toHaveLength(5);
    expect(upcomingTasks(many, NOW, 2)).toHaveLength(2);
  });
});

describe("R-2936 Newly added 5", () => {
  it("the newest open tasks first; done and cancelled ones are left out", () => {
    const list = [
      task({ id: "old", created_at: "2026-11-01T06:30:00Z" }),
      task({ id: "newest", created_at: "2026-11-19T06:00:00Z" }),
      task({ id: "mid", created_at: "2026-11-10T06:30:00Z", status: "snoozed" }),
      task({ id: "done", created_at: "2026-11-19T06:10:00Z", status: "done" }),
      task({ id: "gone", created_at: "2026-11-19T06:20:00Z", status: "cancelled" }),
    ];
    expect(newlyAddedTasks(list).map((t) => t.id)).toEqual(["newest", "mid", "old"]);
    expect(newlyAddedTasks(list, 1).map((t) => t.id)).toEqual(["newest"]);
  });
});

describe("R-2936 links into the Tasks list", () => {
  it("every tab link is one the Tasks page accepts (R-118)", () => {
    for (const tab of ["all", "overdue", "today", "upcoming", "done"] as const) {
      expect(tasksTabHref(tab)).toBe(`/tasks?tab=${tab}`);
      expect(PAGE_CHOICES["/tasks"].tab).toContain(tab);
    }
  });

  it("a task opens by its id (?task=, R-341)", () => {
    expect(taskHref("abc-123")).toBe("/tasks?task=abc-123");
  });
});
