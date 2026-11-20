/* R-2938 — the Tasks page's one filter bar: what a Status / Priority / Assignee choice lets
   through, the number beside each option, who is offered under Assignee, and the link that
   opens the list with a filter set. */
import { describe, it, expect } from "vitest";
import {
  NO_TASK_FILTERS, hasTaskFilters, matchesTaskFilters, taskAssigneeOptions, taskFilterCounts, tasksFilterHref,
  type TaskFilters,
} from "./task-filters";
import { PAGE_CHOICES, TASK_PRIORITY_FILTERS, TASK_STATUS_FILTERS } from "@/lib/navigation/drilldown";

const ME = "u-me", HITESH = "u-hitesh", PAWAN = "u-pawan";
type T = { id: string; status: string; progress?: string | null; priority?: string | null; owner_id: string | null };
const t = (id: string, over: Partial<T> = {}): T => ({ id, status: "pending", progress: "not_started", priority: "medium", owner_id: ME, ...over });
const f = (over: Partial<TaskFilters> = {}): TaskFilters => ({ ...NO_TASK_FILTERS, ...over });
const ids = (tasks: readonly T[], filters: TaskFilters, me: string | null = ME) =>
  tasks.filter((x) => matchesTaskFilters(x, filters, me)).map((x) => x.id);

const TASKS: T[] = [
  t("a", { priority: "high" }),                                              // mine, not started, high
  t("b", { progress: "in_progress" }),                                       // mine, in progress, medium
  t("c", { progress: "on_hold", priority: "low", owner_id: HITESH }),        // Hitesh, on hold, low
  t("d", { priority: "high", owner_id: HITESH }),                            // Hitesh, not started, high
  t("e", { status: "done", priority: "high", owner_id: HITESH }),            // Hitesh, done, high
  t("f", { status: "snoozed", owner_id: null }),                             // nobody's, snoozed = still open
  t("g", { status: "cancelled", priority: "high" }),                         // cancelled — never listed, never counted
  t("h", { priority: null, progress: null, owner_id: PAWAN }),               // an old row: reads Medium, Not started
];

describe("matchesTaskFilters", () => {
  it("no filter lets every task through", () => {
    expect(ids(TASKS, f())).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(hasTaskFilters(f())).toBe(false);
  });

  it("status is the row's status: Not started / In progress / On hold / Done", () => {
    expect(ids(TASKS, f({ status: "in_progress" }))).toEqual(["b"]);
    expect(ids(TASKS, f({ status: "on_hold" }))).toEqual(["c"]);
    expect(ids(TASKS, f({ status: "done" }))).toEqual(["e"]);
    // A row from before the column, and a snoozed task, read Not started.
    expect(ids(TASKS, f({ status: "not_started" }))).toEqual(["a", "d", "f", "g", "h"]);
  });

  it("priority: a row with none reads Medium", () => {
    expect(ids(TASKS, f({ priority: "high" }))).toEqual(["a", "d", "e", "g"]);
    expect(ids(TASKS, f({ priority: "medium" }))).toEqual(["b", "f", "h"]);
    expect(ids(TASKS, f({ priority: "low" }))).toEqual(["c"]);
  });

  it("assignee: Mine is the signed-in person; a person's id is that person", () => {
    expect(ids(TASKS, f({ assignee: "mine" }))).toEqual(["a", "b", "g"]);
    expect(ids(TASKS, f({ assignee: HITESH }))).toEqual(["c", "d", "e"]);
    // Before we know who is signed in, "Mine" shows nothing rather than everyone's.
    expect(ids(TASKS, f({ assignee: "mine" }), null)).toEqual([]);
  });

  it("filters add up (AND)", () => {
    const both = f({ priority: "high", assignee: HITESH });
    expect(ids(TASKS, both)).toEqual(["d", "e"]);
    expect(ids(TASKS, { ...both, status: "done" })).toEqual(["e"]);
    expect(hasTaskFilters(both)).toBe(true);
  });
});

describe("taskFilterCounts — the number beside each option", () => {
  it("counts OPEN tasks per option; Done counts finished ones; cancelled never", () => {
    const c = taskFilterCounts(TASKS, f(), ME);
    expect(c.status).toEqual({ all: 6, not_started: 4, in_progress: 1, on_hold: 1, done: 1 });
    expect(c.priority).toEqual({ all: 6, high: 2, medium: 3, low: 1 });
    expect(c.assignee.all).toBe(6);
    expect(c.assignee.mine).toBe(2);
    expect(c.assignee.byOwner.get(HITESH)).toBe(2);
    expect(c.assignee.byOwner.get(PAWAN)).toBe(1);
  });

  it("an option's number is what you get by picking it with the OTHER filters kept", () => {
    const c = taskFilterCounts(TASKS, f({ assignee: HITESH }), ME);
    // Hitesh's open tasks: c (on hold, low) and d (not started, high).
    expect(c.priority).toEqual({ all: 2, high: 1, medium: 0, low: 1 });
    expect(c.status).toEqual({ all: 2, not_started: 1, in_progress: 0, on_hold: 1, done: 1 });
    // The Assignee numbers ignore the Assignee choice itself — they are what each pick would give.
    expect(c.assignee.all).toBe(6);
    expect(c.assignee.mine).toBe(2);
  });

  it("the picked option's number is the open tasks the list then holds", () => {
    const filters = f({ priority: "high" });
    const c = taskFilterCounts(TASKS, filters, ME);
    const openShown = TASKS.filter((x) => matchesTaskFilters(x, filters, ME) && (x.status === "pending" || x.status === "snoozed"));
    expect(c.priority.high).toBe(openShown.length);
    expect(c.assignee.all).toBe(openShown.length);
  });

  it("with Status = Done picked, Priority and Assignee count the finished tasks", () => {
    const c = taskFilterCounts(TASKS, f({ status: "done" }), ME);
    expect(c.priority).toEqual({ all: 1, high: 1, medium: 0, low: 0 });
    expect(c.assignee.byOwner.get(HITESH)).toBe(1);
    expect(c.assignee.mine).toBe(0);
  });

  it("with a step picked, Priority and Assignee count that step only", () => {
    const c = taskFilterCounts(TASKS, f({ status: "not_started" }), ME);
    expect(c.priority).toEqual({ all: 4, high: 2, medium: 2, low: 0 });
  });
});

describe("taskAssigneeOptions — who is offered under Assignee", () => {
  const member = (id: string, full_name: string, access_ends_on: string | null = null) => ({ id, full_name, email: `${id}@example.test`, access_ends_on });
  const MEMBERS = [
    member(ME, "Pardeep"),
    member(HITESH, "Hitesh"),
    member(PAWAN, "Pawan"),
    member("u-test", "Test Login"),                      // has no task: a test / spare login
    member("u-left", "Left Last Month", "2026-10-31"),   // access ended
  ];
  const WITH_LEFT = [...TASKS, t("z", { owner_id: "u-left", status: "done" })];

  it("offers teammates who have a task, by name — not me (that is 'Mine'), not a login with no task, not one whose access ended and who has nothing open", () => {
    expect(taskAssigneeOptions(MEMBERS, WITH_LEFT, ME, "all", "2026-11-20")).toEqual([
      { id: HITESH, label: "Hitesh" },
      { id: PAWAN, label: "Pawan" },
    ]);
  });

  it("someone whose access ended but who still owns OPEN work is offered — it has to be found to be handed over", () => {
    const stillOpen = [...TASKS, t("z", { owner_id: "u-left" })];
    expect(taskAssigneeOptions(MEMBERS, stillOpen, ME, "all", "2026-11-20").map((o) => o.label)).toEqual(["Hitesh", "Left Last Month", "Pawan"]);
  });

  it("my own id in the address is 'Mine' — I am not offered a second time by name", () => {
    expect(taskAssigneeOptions(MEMBERS, TASKS, ME, ME, "2026-11-20").map((o) => o.id)).toEqual([HITESH, PAWAN]);
  });

  it("while the team is still loading, the person in the address is 'Teammate', not 'Former teammate'", () => {
    expect(taskAssigneeOptions([], TASKS, ME, HITESH, "2026-11-20", false)).toEqual([{ id: HITESH, label: "Teammate" }]);
  });

  it("a teammate whose only tasks are cancelled is not offered", () => {
    const only = [t("x", { owner_id: PAWAN, status: "cancelled" }), t("y", { owner_id: HITESH })];
    expect(taskAssigneeOptions(MEMBERS, only, ME, "all", "2026-11-20").map((o) => o.label)).toEqual(["Hitesh"]);
  });

  it("the person in the address is always offered, so the box never shows a blank", () => {
    const opts = taskAssigneeOptions(MEMBERS, WITH_LEFT, ME, "u-test", "2026-11-20");
    expect(opts.map((o) => o.id)).toEqual([HITESH, PAWAN, "u-test"]);
    // …even an id that is no teammate at all (an old link): named plainly.
    expect(taskAssigneeOptions(MEMBERS, TASKS, ME, "u-gone", "2026-11-20").at(-1)).toEqual({ id: "u-gone", label: "Former teammate" });
  });

  it("access ending today still counts as active", () => {
    const m = [member(ME, "Pardeep"), member(HITESH, "Hitesh", "2026-11-20")];
    expect(taskAssigneeOptions(m, TASKS, ME, "all", "2026-11-20").map((o) => o.id)).toEqual([HITESH]);
  });
});

describe("tasksFilterHref — a link that opens the list filtered", () => {
  it("builds /tasks with only the filters that are set", () => {
    expect(tasksFilterHref({ status: "in_progress" })).toBe("/tasks?status=in_progress");
    expect(tasksFilterHref({ priority: "high" })).toBe("/tasks?priority=high");
    expect(tasksFilterHref({ status: "on_hold", priority: "low" })).toBe("/tasks?status=on_hold&priority=low");
    expect(tasksFilterHref({})).toBe("/tasks");
    expect(tasksFilterHref({ status: "all", priority: "all" })).toBe("/tasks");
  });

  it("every value it can carry is one the Tasks page accepts (lib/navigation/drilldown)", () => {
    expect(PAGE_CHOICES["/tasks"].status).toBe(TASK_STATUS_FILTERS);
    expect(PAGE_CHOICES["/tasks"].priority).toBe(TASK_PRIORITY_FILTERS);
    expect([...TASK_STATUS_FILTERS]).toEqual(["all", "not_started", "in_progress", "on_hold", "done"]);
    expect([...TASK_PRIORITY_FILTERS]).toEqual(["all", "high", "medium", "low"]);
  });
});
