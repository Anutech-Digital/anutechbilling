import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TASK_ROW_STATUSES, TASK_ROW_STATUS_META, rowStatusChange, rowStatusOf } from "./task-progress";
import { groupTasks, taskTabCounts } from "./task-groups";
import { TASK_OPEN_STATUSES, patchTaskInCache, progressPatch } from "@/lib/queries/tasks";

const NOW = new Date("2026-11-18T06:30:00Z"); // 12:00 IST

describe("R-2927 row status", () => {
  it("the menu offers Not started / In progress / On hold / Done, in that order, in English", () => {
    expect(TASK_ROW_STATUSES.map((s) => TASK_ROW_STATUS_META[s].label)).toEqual(["Not started", "In progress", "On hold", "Done"]);
  });

  it("reads Done from status, the step from progress; old rows are Not started", () => {
    expect(rowStatusOf({ status: "done", progress: "in_progress" })).toBe("done");
    expect(rowStatusOf({ status: "pending", progress: "in_progress" })).toBe("in_progress");
    expect(rowStatusOf({ status: "snoozed", progress: "on_hold" })).toBe("on_hold");
    expect(rowStatusOf({ status: "pending" })).toBe("not_started");
    expect(rowStatusOf({ status: "pending", progress: "weird" })).toBe("not_started");
  });

  it("In progress / On hold only save the step — the task's status is not touched", () => {
    expect(rowStatusChange({ status: "pending", progress: "not_started" }, "in_progress")).toEqual({ progress: "in_progress" });
    expect(rowStatusChange({ status: "pending", progress: "in_progress" }, "on_hold")).toEqual({ progress: "on_hold" });
    expect(rowStatusChange({ status: "pending", progress: "on_hold" }, "not_started")).toEqual({ progress: "not_started" });
  });

  it("Done goes through the one-click-done path; leaving Done reopens and sets the step", () => {
    expect(rowStatusChange({ status: "pending", progress: "in_progress" }, "done")).toEqual({ complete: true });
    expect(rowStatusChange({ status: "done", progress: "in_progress" }, "on_hold")).toEqual({ reopen: true, progress: "on_hold" });
  });

  it("picking what it already is does nothing", () => {
    expect(rowStatusChange({ status: "pending", progress: "in_progress" }, "in_progress")).toBeNull();
    expect(rowStatusChange({ status: "done" }, "done")).toBeNull();
  });
});

describe("R-2927 counts stay right", () => {
  const t = (id: string, due: string, progress: string) =>
    ({ id, status: "pending", due_at: due, progress, completed_at: null }) as never as { id: string; status: "pending"; due_at: string };

  it("an In progress / On hold task stays in the same group, and the tab counts do not move", () => {
    const before = groupTasks([t("a", "2026-11-10T04:00:00Z", "not_started"), t("b", "2026-11-18T10:00:00Z", "not_started"), t("c", "2026-11-25T04:00:00Z", "not_started")], NOW);
    const after = groupTasks([t("a", "2026-11-10T04:00:00Z", "in_progress"), t("b", "2026-11-18T10:00:00Z", "on_hold"), t("c", "2026-11-25T04:00:00Z", "in_progress")], NOW);
    expect(taskTabCounts(after)).toEqual(taskTabCounts(before));
    expect(taskTabCounts(after)).toMatchObject({ overdue: 1, today: 1, upcoming: 1, done: 0 });
  });

  it("'open' is still exactly pending + snoozed — the list the Overdue badge and Today SQL are held to", () => {
    expect([...TASK_OPEN_STATUSES]).toEqual(["pending", "snoozed"]);
  });

  it("no new task_status value was added (the enum is what ~30 SQL functions compare against)", () => {
    const types = readFileSync(join(__dirname, "../../../lib/supabase/database.generated.ts"), "utf8");
    expect(types).toContain('task_status: "pending" | "done" | "snoozed" | "cancelled"');
    const dir = join(__dirname, "../../../../supabase/migrations");
    const file = readdirSync(dir).find((f) => /_r2927_task_progress\.sql$/.test(f));
    if (!file) return; // squashed into a baseline later — the enum check above still holds
    const sql = readFileSync(join(dir, file), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/alter type/i);
    expect(code).toMatch(/add column if not exists progress text not null default 'not_started'/);
    expect(code).toMatch(/progress in \('not_started', 'in_progress', 'on_hold'\)/);
    expect(sql.split("\n")[0]).toMatch(/^-- deploy-peek: /);
  });

  it("the optimistic cache patch carries the step, so the row changes at once", () => {
    const rows = [{ id: "a", status: "pending", progress: "not_started" }, { id: "b", status: "pending", progress: "not_started" }];
    expect(patchTaskInCache(rows, "a", { progress: "in_progress" })).toEqual([{ id: "a", status: "pending", progress: "in_progress" }, rows[1]]);
  });
});

describe("R-2927 saves", () => {
  it("a step on an open task saves only the step", () => {
    expect(progressPatch("in_progress")).toEqual({ progress: "in_progress" });
  });
  it("a step picked on a Done task reopens it in the same save (status back to pending, stamps cleared)", () => {
    expect(progressPatch("on_hold", true)).toEqual({ progress: "on_hold", status: "pending", completed_at: null, completed_by: null });
  });
});

describe("R-2927 wiring", () => {
  const row = readFileSync(join(__dirname, "task-row.tsx"), "utf8");
  const menu = readFileSync(join(__dirname, "task-status-menu.tsx"), "utf8");
  it("the row has the status menu and decides the change with rowStatusChange", () => {
    expect(row).toMatch(/<TaskStatusMenu task=\{task\} busy=\{statusBusy\} onPick=\{pickStatus\}/);
    expect(row).toMatch(/rowStatusChange\(task, next\)/);
  });
  it("the circle and the menu share ONE in-flight guard (no two status saves racing)", () => {
    expect(row).toMatch(/const statusBusy\s+= completeTask\.isPending \|\| reopenTask\.isPending \|\| setProgress\.isPending/);
    expect(row.match(/if \(statusBusy\) return;/g)?.length).toBe(1);
    expect(menu).not.toMatch(/useMutation|useCompleteTask|useSetTaskProgress/);
  });
  it("the menu is a labelled single-choice list and its trigger is never disabled (focus returns to it)", () => {
    expect(menu).toMatch(/aria-label=\{`Status: /);
    expect(menu).toMatch(/DropdownMenuCheckboxItem key=\{s\} checked=\{s === current\}/);
    expect(menu).not.toMatch(/disabled=/);
  });
});
