import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_PRIORITIES, TASK_PRIORITY_META, priorityForCreate, priorityOf, priorityRank, showsPriorityBadge } from "./task-priority";
import { groupTasks } from "./task-groups";
import { parseQuickAdd } from "./quick-add-parse";

const NOW = new Date("2026-11-18T06:30:00Z"); // 12:00 IST

describe("R-2926 task priority", () => {
  it("three levels, Medium by default (old rows and unknown values read as Medium)", () => {
    expect(TASK_PRIORITIES).toEqual(["low", "medium", "high"]);
    expect(priorityOf({ priority: "high" })).toBe("high");
    expect(priorityOf({ priority: null })).toBe("medium");
    expect(priorityOf({})).toBe("medium");
    expect(priorityOf({ priority: "urgent!!" })).toBe("medium");
  });

  it("only High and Low get a badge on the row — Medium is the default and shows nothing", () => {
    expect(showsPriorityBadge("high")).toBe(true);
    expect(showsPriorityBadge("low")).toBe(true);
    expect(showsPriorityBadge("medium")).toBe(false);
  });

  it("a new task sends priority only when it is not the default (so a save works before the column exists)", () => {
    expect(priorityForCreate("high")).toEqual({ priority: "high" });
    expect(priorityForCreate("medium")).toEqual({});
  });

  it("High is red, Medium amber, Low grey — each with its word (never colour alone)", () => {
    expect(TASK_PRIORITY_META.high).toMatchObject({ label: "High", badge: "danger" });
    expect(TASK_PRIORITY_META.medium).toMatchObject({ label: "Medium", badge: "warning" });
    expect(TASK_PRIORITY_META.low).toMatchObject({ label: "Low", badge: "muted" });
  });

  it("High sorts before Medium before Low", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("medium"));
    expect(priorityRank("medium")).toBeLessThan(priorityRank("low"));
  });
});

describe("R-2926 list order: High first inside each group", () => {
  const t = (id: string, due: string, priority: string | null, status = "pending") =>
    ({ id, status, due_at: due, priority, completed_at: null }) as never as { id: string; status: "pending"; due_at: string; priority: string | null };

  it("inside Upcoming: High, then Medium, then Low; same priority = soonest due first", () => {
    const groups = groupTasks([
      t("med-soon", "2026-11-19T04:00:00Z", "medium"),
      t("low-soonest", "2026-11-19T03:00:00Z", "low"),
      t("high-late", "2026-11-25T04:00:00Z", "high"),
      t("high-soon", "2026-11-20T04:00:00Z", "high"),
      t("old-row", "2026-11-19T05:00:00Z", null),
    ], NOW);
    expect(groups.find((g) => g.id === "upcoming")!.tasks.map((x) => x.id))
      .toEqual(["high-soon", "high-late", "med-soon", "old-row", "low-soonest"]);
  });

  it("priority never moves a task to another group (an overdue Low stays in Overdue)", () => {
    const groups = groupTasks([
      t("low-overdue", "2026-11-10T04:00:00Z", "low"),
      t("high-upcoming", "2026-11-25T04:00:00Z", "high"),
    ], NOW);
    expect(groups.find((g) => g.id === "overdue")!.tasks.map((x) => x.id)).toEqual(["low-overdue"]);
    expect(groups.find((g) => g.id === "upcoming")!.tasks.map((x) => x.id)).toEqual(["high-upcoming"]);
  });

  it("Done keeps its own order (most recently completed first), whatever the priority", () => {
    const done = (id: string, at: string, priority: string) =>
      ({ id, status: "done", due_at: at, completed_at: at, priority }) as never as { id: string; status: "done"; due_at: string; priority: string };
    const groups = groupTasks([done("low-new", "2026-11-17T04:00:00Z", "low"), done("high-old", "2026-11-10T04:00:00Z", "high")], NOW);
    expect(groups.find((g) => g.id === "done")!.tasks.map((x) => x.id)).toEqual(["low-new", "high-old"]);
  });
});

describe("R-2926 quick add understands priority", () => {
  it("'!high' sets High and leaves the title clean", () => {
    const p = parseQuickAdd("Call Amit tomorrow 3 PM !high", NOW);
    expect(p.priority).toBe("high");
    expect(p.title).toBe("Call Amit");
  });
  it("the word 'urgent' means High wherever it is typed — and stays in the title, so no word is lost", () => {
    expect(parseQuickAdd("Call Amit urgent tomorrow 3 PM", NOW)).toMatchObject({ priority: "high", title: "Call Amit urgent", kind: "call" });
    expect(parseQuickAdd("Mark ticket as urgent", NOW)).toMatchObject({ priority: "high", title: "Mark ticket as urgent" });
    expect(parseQuickAdd("Call Amit urgent!", NOW).priority).toBe("high");
  });
  it("'Urgent:' as a label in front is taken off the title", () => {
    expect(parseQuickAdd("Urgent: call Amit", NOW)).toMatchObject({ priority: "high", title: "call Amit", kind: "call" });
  });
  it("'not urgent' is not High", () => {
    expect(parseQuickAdd("Send brochure, not urgent", NOW)).toMatchObject({ priority: "medium", title: "Send brochure, not urgent" });
  });
  it("'!low' Low; '!medium' Medium; '!urgent' High", () => {
    expect(parseQuickAdd("Call Amit !urgent", NOW)).toMatchObject({ priority: "high", title: "Call Amit" });
    expect(parseQuickAdd("Send brochure !low", NOW)).toMatchObject({ priority: "low", title: "Send brochure" });
    expect(parseQuickAdd("Send brochure !medium", NOW)).toMatchObject({ priority: "medium", title: "Send brochure" });
  });
  it("no priority word: Medium, and the title is untouched ('high' inside a sentence is not a priority)", () => {
    expect(parseQuickAdd("Discuss high value deal with Amit", NOW)).toMatchObject({ priority: "medium", title: "Discuss high value deal with Amit" });
    expect(parseQuickAdd("Urgently needed: laptop", NOW).priority).toBe("medium");
  });
});

describe("R-2926 wiring", () => {
  const here = (f: string) => readFileSync(join(__dirname, f), "utf8");
  it("the row shows the priority badge, the dialog has a Priority select, quick add saves it", () => {
    expect(here("task-row.tsx")).toMatch(/TASK_PRIORITY_META\[/);
    expect(here("add-task-dialog.tsx")).toMatch(/label="Priority"/);
    expect(here("add-task-dialog.tsx")).toMatch(/priorityForCreate\(data\.priority\)/);
    expect(here("add-task-dialog.tsx")).toMatch(/priority:\s*data\.priority/); // an edit always says it
    expect(here("task-quick-add.tsx")).toMatch(/priorityForCreate\(parsed\.priority\)/);
  });
  it("the migration adds tasks.priority low/medium/high, default medium, safely", () => {
    const dir = join(__dirname, "../../../../supabase/migrations");
    const file = readdirSync(dir).find((f) => /_r2926_task_priority\.sql$/.test(f))!;
    const sql = readFileSync(join(dir, file), "utf8");
    expect(sql.split("\n")[0]).toMatch(/^-- deploy-peek: /);
    expect(sql).not.toMatch(/::regclass/);
    expect(sql).toMatch(/add column if not exists priority text not null default 'medium'/);
    expect(sql).toMatch(/priority in \('low', 'medium', 'high'\)/);
  });
});
