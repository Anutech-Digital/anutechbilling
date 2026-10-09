import { describe, it, expect } from "vitest";
import { groupTasks, taskGroupOf } from "./task-groups";

// 7 Oct 2026, 15:00 IST
const NOW = new Date("2026-10-07T09:30:00Z");
const t = (id: string, due_at: string | null, status: "pending" | "done" | "snoozed" | "cancelled" = "pending", completed_at: string | null = null) =>
  ({ id, due_at, status, completed_at });

describe("R-354 task groups by IST day", () => {
  it("23:59 IST today is Today, 00:01 IST tomorrow is Upcoming", () => {
    expect(taskGroupOf(t("a", "2026-10-07T18:29:00Z"), NOW)).toBe("today");
    expect(taskGroupOf(t("b", "2026-10-07T18:31:00Z"), NOW)).toBe("upcoming");
  });

  it("23:59 IST yesterday is Overdue, later today is Today (even when that is a past UTC date)", () => {
    expect(taskGroupOf(t("a", "2026-10-06T18:29:00Z"), NOW)).toBe("overdue");
    const earlyMorning = new Date("2026-10-06T18:35:00Z"); // 7 Oct 00:05 IST — still 6 Oct in UTC
    expect(taskGroupOf(t("b", "2026-10-06T18:31:00Z"), earlyMorning)).toBe("overdue");
    expect(taskGroupOf(t("c", "2026-10-07T03:30:00Z"), earlyMorning)).toBe("today");
  });

  it("R-471: a task due earlier today is Overdue, not Today (the row already said ⚠ Overdue)", () => {
    const noon = new Date("2026-10-09T06:30:00Z"); // 9 Oct 12:00 IST
    expect(taskGroupOf(t("call", "2026-10-09T04:30:00Z"), noon)).toBe("overdue"); // 10:00 IST
    expect(taskGroupOf(t("later", "2026-10-09T09:30:00Z"), noon)).toBe("today"); // 15:00 IST
    const groups = groupTasks([t("call", "2026-10-09T04:30:00Z")], noon);
    expect(groups.find((g) => g.id === "overdue")!.tasks.map((x) => x.id)).toEqual(["call"]);
    expect(groups.find((g) => g.id === "today")!.tasks).toEqual([]);
  });

  it("just after IST midnight the boundary moves with it", () => {
    const after = new Date("2026-10-07T18:31:00Z"); // 8 Oct 00:01 IST
    expect(taskGroupOf(t("a", "2026-10-07T18:29:00Z"), after)).toBe("overdue");
    expect(taskGroupOf(t("b", "2026-10-07T20:00:00Z"), after)).toBe("today");
  });

  it("done, snoozed, cancelled and no date", () => {
    expect(taskGroupOf(t("a", "2026-10-01T00:00:00Z", "done"), NOW)).toBe("done");
    expect(taskGroupOf(t("b", "2026-10-09T00:00:00Z", "snoozed"), NOW)).toBe("upcoming");
    expect(taskGroupOf(t("c", "2026-10-09T00:00:00Z", "cancelled"), NOW)).toBeNull();
    expect(taskGroupOf(t("d", null), NOW)).toBe("nodate");
  });

  it("groupTasks keeps the order and sorts within each group", () => {
    const groups = groupTasks([
      t("up2", "2026-10-10T05:00:00Z"),
      t("od", "2026-10-01T05:00:00Z"),
      t("up1", "2026-10-09T05:00:00Z"),
      t("d-old", "2026-10-01T05:00:00Z", "done", "2026-10-02T05:00:00Z"),
      t("d-new", "2026-10-01T05:00:00Z", "done", "2026-10-06T05:00:00Z"),
      t("x", "2026-10-01T05:00:00Z", "cancelled"),
    ], NOW);
    expect(groups.map((g) => g.id)).toEqual(["overdue", "today", "upcoming", "nodate", "done"]);
    expect(groups[2].tasks.map((x) => x.id)).toEqual(["up1", "up2"]);
    expect(groups[4].tasks.map((x) => x.id)).toEqual(["d-new", "d-old"]);
    expect(groups.flatMap((g) => g.tasks).some((x) => x.id === "x")).toBe(false);
  });
});
