import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupTasks, taskGroupOf, taskTabCounts } from "./task-groups";
import { taskSections, taskSummary } from "./task-overview";
import { NO_TASK_FILTERS, taskAssigneeOptions, taskFilterCounts } from "./task-filters";
import { goalProgress, goalProgressLabel, goalsWithSubTasks, goalTitleBySubTask } from "./task-goals";
import { dueStrip, newlyAddedTasks, prioritySlices, statusSlices, upcomingTasks } from "@/app/(app)/tasks/overview/overview-counts";
import { fetchCalendarTasks } from "@/app/(app)/tasks/calendar/calendar-tasks";
import { fetchTeamTasks } from "@/app/(app)/reports/team-tasks/team-tasks-data";
import { fetchGoalRows, fetchTaskList, GOAL_ROWS_FILTER, TASK_SELECT } from "@/lib/queries/tasks";

/* R-2957 — a task can have sub-tasks. The counting rule (owner's decision 3): the sub-tasks are
   the work and are counted like any task; the goal row itself is in NO count or list of work —
   or the same work would be counted twice. Today nobody can make a goal from a screen, so with
   no goal row every number below is what it was (the "same as before" cases). */

const NOW = new Date("2026-11-20T06:30:00Z"); // 20 Nov 2026, 12:00 IST

type Row = {
  id: string; title: string; status: "pending" | "snoozed" | "done" | "cancelled"; due_at: string | null; completed_at?: string | null;
  priority?: string | null; progress?: string | null; owner_id: string | null; created_at: string;
  is_goal?: boolean; parent_task_id?: string | null;
};
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, title: id, status: "pending", due_at: "2026-11-19T06:30:00Z", priority: "medium", progress: "not_started",
  owner_id: "u1", created_at: "2026-11-18T06:30:00Z", is_goal: false, parent_task_id: null, ...over,
});

/* One overdue goal with two overdue sub-tasks (one in progress), one finished sub-task, and one
   separate overdue task. Work still open = s1, s2, plain → 3. */
const GOAL = row("goal", { is_goal: true });
const S1 = row("s1", { parent_task_id: "goal" });
const S2 = row("s2", { parent_task_id: "goal", progress: "in_progress", owner_id: "u2" });
const S3 = row("s3", { parent_task_id: "goal", status: "done", completed_at: "2026-11-19T07:00:00Z" });
const PLAIN = row("plain");
const ALL = [GOAL, S1, S2, S3, PLAIN];
const WITHOUT_GOAL = [S1, S2, S3, PLAIN];

describe("R-2957 the goal row is in no group, tab or card — its sub-tasks are", () => {
  it("taskGroupOf: a goal has no group (like a cancelled task); a sub-task groups like any task", () => {
    expect(taskGroupOf(GOAL, NOW)).toBeNull();
    expect(taskGroupOf(S1, NOW)).toBe("overdue");
    expect(taskGroupOf(S3, NOW)).toBe("done");
    expect(taskGroupOf(row("done-goal", { is_goal: true, status: "done" }), NOW)).toBeNull();
  });

  it("the list's groups, tab counts and sections never hold the goal", () => {
    const groups = groupTasks(ALL, NOW);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id)).sort()).toEqual(["plain", "s1", "s2", "s3"]);
    expect(taskTabCounts(groups)).toEqual({ all: 4, overdue: 3, today: 0, upcoming: 0, done: 1 });
    expect(taskSections(groups, NOW).flatMap((s) => s.tasks.map((t) => t.id))).not.toContain("goal");
  });

  it("Summary strip and the Overview numbers: 3 open, not 4", () => {
    expect(taskSummary(ALL, NOW)).toMatchObject({ open: 3, overdue: 3, today: 0, doneThisWeek: 1 });
    expect(dueStrip(ALL, NOW)).toMatchObject({ overdue: 3, today: 0 });
    expect(statusSlices(ALL, NOW).map((s) => [s.id, s.count])).toEqual([["not_started", 2], ["in_progress", 1], ["on_hold", 0]]);
    expect(prioritySlices(ALL, NOW).reduce((n, s) => n + s.count, 0)).toBe(3);
    expect(newlyAddedTasks(ALL, 10, NOW).map((t) => t.id)).not.toContain("goal");
    const ahead = [row("goal2", { is_goal: true, due_at: "2026-11-21T06:30:00Z" }), row("s9", { parent_task_id: "goal2", due_at: "2026-11-21T06:30:00Z" })];
    expect(upcomingTasks(ahead, NOW).map((t) => t.id)).toEqual(["s9"]);
  });

  it("filter bar counts and the Assignee list do not count the goal", () => {
    const c = taskFilterCounts(ALL, NO_TASK_FILTERS, "u1");
    expect(c.status).toMatchObject({ all: 3, not_started: 2, in_progress: 1, done: 1 });
    expect(c.priority.all).toBe(3);
    expect(c.assignee).toMatchObject({ all: 3, mine: 2 });
    /* A teammate whose only row is a goal has no work to filter to. */
    const onlyGoal = [row("g", { is_goal: true, owner_id: "u3" }), PLAIN];
    const members = [{ id: "u1", full_name: "A" }, { id: "u3", full_name: "C" }];
    expect(taskAssigneeOptions(members, onlyGoal, "u1", "all", "2026-11-20")).toEqual([]);
  });

  it("with no goal row every number is what it was before (today's data)", () => {
    const strip = (rows: Row[]) => rows.map((r) => { const { is_goal: _g, parent_task_id: _p, ...old } = r; return old; });
    const before = strip(WITHOUT_GOAL);
    expect(taskTabCounts(groupTasks(WITHOUT_GOAL, NOW))).toEqual(taskTabCounts(groupTasks(before, NOW)));
    expect(taskSummary(WITHOUT_GOAL, NOW)).toEqual(taskSummary(before, NOW));
    expect(taskFilterCounts(WITHOUT_GOAL, NO_TASK_FILTERS, "u1")).toEqual(taskFilterCounts(before, NO_TASK_FILTERS, "u1"));
    expect(taskTabCounts(groupTasks(WITHOUT_GOAL, NOW))).toEqual(taskTabCounts(groupTasks(ALL, NOW)));
  });
});

/* ── the reads ─────────────────────────────────────────────────────────────────────── */

type Rec = { table: string; select: string; eqs: [string, unknown][]; ors: string[]; ranges: number };
function recordingDb(rows: unknown[] = []) {
  const calls: Rec[] = [];
  const db = {
    from(table: string) {
      const rec: Rec = { table, select: "", eqs: [], ors: [], ranges: 0 };
      calls.push(rec);
      const result = { data: rows, error: null };
      const q: Record<string, unknown> = {
        select: (s: string) => { rec.select = s; return q; },
        eq: (c: string, v: unknown) => { rec.eqs.push([c, v]); return q; },
        neq: () => q, in: () => q, gte: () => q, lt: () => q, order: () => q,
        or: (f: string) => { rec.ors.push(f); return q; },
        limit: () => Promise.resolve(result),
        range: () => { rec.ranges++; return Promise.resolve(result); },
      };
      return q;
    },
  };
  return { db, calls };
}

describe("R-2957 every read that lists or counts work leaves the goal row out", () => {
  it("the Tasks list (open + done reads)", async () => {
    const { db, calls } = recordingDb();
    await fetchTaskList(db as unknown as Parameters<typeof fetchTaskList>[0], "tenant-1");
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.eqs).toContainEqual(["is_goal", false]);
  });

  it("the calendar", async () => {
    const { db, calls } = recordingDb();
    await fetchCalendarTasks(db as unknown as Parameters<typeof fetchCalendarTasks>[0], "tenant-1", "2026-11");
    expect(calls[0].eqs).toContainEqual(["is_goal", false]);
  });

  it("Reports → Team tasks (all three reads)", async () => {
    const { db, calls } = recordingDb();
    await fetchTeamTasks(db as unknown as Parameters<typeof fetchTeamTasks>[0], "tenant-1", NOW);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.eqs).toContainEqual(["is_goal", false]);
  });

  /* The hooks and pages cannot run here without React and a server, so their source is held:
     in each file, every read of `tasks` that lists or counts work carries the filter. The
     number is how many such reads the file has today — a new work read must add the filter
     and raise the number; by-id reads (open one task, send a notice) and writes are not work
     reads and carry none. */
  const WORK_READS: [file: string, reads: number, what: string][] = [
    ["src/lib/queries/tasks.ts", 6, "useTasks, the bell, the list (open + done), the leads list chip, the lead drawer"],
    ["src/app/(app)/tasks/page.tsx", 1, "Summary strip: Done this week"],
    ["src/app/(app)/tasks/overview/page.tsx", 1, "Overview: Done this week"],
    ["src/app/(app)/tasks/calendar/calendar-tasks.ts", 1, "calendar"],
    ["src/app/(app)/reports/team-tasks/team-tasks-data.ts", 1, "Team tasks report (one base() for its three reads)"],
    ["src/app/api/cron/task-digest/route.ts", 1, "morning digest"],
    ["src/lib/queries/performance.ts", 1, "performance points"],
    ["src/lib/inbound/ingest.ts", 1, "an enquiry mail's lead follow-up (pulls the open follow-up's date forward)"],
  ];
  it.each(WORK_READS)("%s — %i work read(s) carry .eq(\"is_goal\", false)", (file, reads) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    expect(src.match(/\.eq\("is_goal", false\)/g) ?? []).toHaveLength(reads);
  });
});

/* ── what R-2958 builds on ─────────────────────────────────────────────────────────── */

describe("R-2957 goals with their sub-tasks and \"N of M done\" from one read", () => {
  it("fetchGoalRows: one tenant-scoped request for the goals and every sub-task — none per goal", async () => {
    const { db, calls } = recordingDb([GOAL, S1, S2, S3]);
    const rows = await fetchGoalRows(db as unknown as Parameters<typeof fetchGoalRows>[0], "tenant-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "tasks", select: TASK_SELECT, ors: [GOAL_ROWS_FILTER], ranges: 1 });
    expect(calls[0].eqs).toEqual([["tenant_id", "tenant-1"]]);
    expect(GOAL_ROWS_FILTER).toBe("is_goal.eq.true,parent_task_id.not.is.null");
    expect(rows).toHaveLength(4);
  });

  it("goalsWithSubTasks: each goal gets its own sub-tasks and its progress", () => {
    const g2 = row("goal-b", { is_goal: true });
    const lost = row("lost", { parent_task_id: "not-in-the-list" });
    const out = goalsWithSubTasks([S2, GOAL, g2, S3, lost, S1, PLAIN]);
    expect(out.map((g) => g.goal.id)).toEqual(["goal", "goal-b"]);
    expect(out[0].subTasks.map((t) => t.id).sort()).toEqual(["s1", "s2", "s3"]);
    expect(out[0].progress).toEqual({ done: 1, total: 3, open: 2, percent: 33, status: "in_progress" });
    expect(goalProgressLabel(out[0].progress)).toBe("1 of 3 done");
    expect(out[1]).toMatchObject({ subTasks: [], progress: { done: 0, total: 0, open: 0, percent: 0, status: null } });
  });

  it("goalProgress: the goal's status comes from its sub-tasks; cancelled ones are in neither number", () => {
    const t = (status: string, progress = "not_started") => ({ status, progress });
    expect(goalProgress([t("pending"), t("snoozed")])).toMatchObject({ done: 0, total: 2, status: "not_started" });
    expect(goalProgress([t("pending", "in_progress"), t("pending")]).status).toBe("in_progress");
    expect(goalProgress([t("pending", "on_hold"), t("pending")]).status).toBe("in_progress");
    expect(goalProgress([t("done"), t("pending")])).toMatchObject({ done: 1, total: 2, open: 1, percent: 50, status: "in_progress" });
    expect(goalProgress([t("done"), t("done")])).toMatchObject({ done: 2, total: 2, open: 0, percent: 100, status: "done" });
    expect(goalProgress([t("done"), t("cancelled")])).toMatchObject({ done: 1, total: 1, status: "done" });
    expect(goalProgress([t("cancelled")])).toMatchObject({ done: 0, total: 0, status: null });
    expect(goalProgress([])).toMatchObject({ done: 0, total: 0, percent: 0, status: null });
  });

  it("goalTitleBySubTask: a sub-task's goal title without a lookup per row", () => {
    const titled = [{ ...GOAL, title: "Launch the new plan" }, S1, S2, PLAIN];
    const m = goalTitleBySubTask(titled);
    expect([...m.entries()]).toEqual([["s1", "Launch the new plan"], ["s2", "Launch the new plan"]]);
  });
});
