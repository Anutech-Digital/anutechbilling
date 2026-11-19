import { describe, it, expect } from "vitest";
import {
  isMonth, monthWeeks, shiftMonth, gridRangeUtc, tasksByDay, taskTone, moveDueToDay, WEEKDAYS,
} from "./calendar-grid";

/* R-2931 — /tasks/calendar: a month grid, every task on its IST due day. */

const task = (id: string, due_at: string, status = "pending") => ({ id, due_at, status: status as "pending" | "snoozed" | "done" | "cancelled", title: id });

describe("R-2931 month grid", () => {
  it("November 2026 runs Monday → Sunday, six rows only when the month needs them", () => {
    const weeks = monthWeeks("2026-11");
    expect(WEEKDAYS).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toBe("2026-10-26");            // 1 Nov 2026 is a Sunday
    expect(weeks[0][6]).toBe("2026-11-01");
    expect(weeks.at(-1)![0]).toBe("2026-11-30");
    expect(weeks.at(-1)![6]).toBe("2026-12-06");
    expect(weeks).toHaveLength(6);
    expect(monthWeeks("2027-02")).toHaveLength(4);      // 1 Feb 2027 is a Monday, 28 days
  });

  it("moves a month back and forward across the year end", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 0)).toBe("2026-11");
  });

  it("accepts only a real YYYY-MM month from the URL", () => {
    expect(isMonth("2026-11")).toBe(true);
    for (const bad of ["", "2026-13", "2026-00", "26-11", "2026-11-01", "abcd-ef"]) expect(isMonth(bad)).toBe(false);
  });

  it("reads the whole visible grid, by IST midnight", () => {
    expect(gridRangeUtc("2026-11")).toEqual({ fromISO: "2026-10-25T18:30:00.000Z", toISO: "2026-12-06T18:30:00.000Z" });
  });
});

describe("R-2931 tasks land on their IST due day", () => {
  it("a task due 00:10 IST belongs to that IST day, not the UTC day before", () => {
    const by = tasksByDay([
      task("late", "2026-11-18T18:40:00Z"),             // 19 Nov 00:10 IST
      task("noon", "2026-11-18T06:30:00Z"),             // 18 Nov 12:00 IST
      task("morning", "2026-11-18T03:30:00Z"),          // 18 Nov 09:00 IST
    ]);
    expect(by.get("2026-11-18")!.map((t) => t.id)).toEqual(["morning", "noon"]); // earliest first
    expect(by.get("2026-11-19")!.map((t) => t.id)).toEqual(["late"]);
  });

  it("leaves cancelled tasks out; done tasks stay on their due day", () => {
    const by = tasksByDay([task("x", "2026-11-18T06:30:00Z", "cancelled"), task("d", "2026-11-18T06:30:00Z", "done")]);
    expect(by.get("2026-11-18")!.map((t) => t.id)).toEqual(["d"]);
  });
});

describe("R-2931 colour of a task", () => {
  const now = new Date("2026-11-18T06:30:00Z"); // 18 Nov 12:00 IST
  it("done / overdue / today / upcoming — the same split as the Tasks list", () => {
    expect(taskTone(task("a", "2026-11-10T06:30:00Z", "done"), now)).toBe("done");
    expect(taskTone(task("b", "2026-11-18T05:00:00Z"), now)).toBe("overdue");   // earlier today
    expect(taskTone(task("c", "2026-11-18T12:00:00Z"), now)).toBe("today");
    expect(taskTone(task("d", "2026-11-20T12:00:00Z", "snoozed"), now)).toBe("upcoming");
  });
});

describe("R-2931 drag to another day", () => {
  it("changes the day and keeps the IST clock time", () => {
    // 18 Nov 15:00 IST → 25 Nov 15:00 IST
    expect(moveDueToDay("2026-11-18T09:30:00.000Z", "2026-11-25")).toBe("2026-11-25T09:30:00.000Z");
    // 19 Nov 00:10 IST (18 Nov UTC) → 1 Dec 00:10 IST
    expect(moveDueToDay("2026-11-18T18:40:00.000Z", "2026-12-01")).toBe("2026-11-30T18:40:00.000Z");
  });

  it("returns null when the task is already on that day", () => {
    expect(moveDueToDay("2026-11-18T18:40:00.000Z", "2026-11-19")).toBeNull();
  });
});
