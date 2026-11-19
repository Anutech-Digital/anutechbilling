import { describe, it, expect } from "vitest";
import { fetchCalendarTasks, calendarTasksKey } from "./calendar-tasks";
import { TASK_SELECT } from "@/lib/queries/tasks";

/* R-2931 — one tenant-scoped read of the tasks due inside the visible month grid. */

describe("R-2931 fetchCalendarTasks", () => {
  it("reads the visible grid for one tenant, without cancelled tasks, every page", async () => {
    const rec = { table: "", select: "", eqs: [] as [string, unknown][], neqs: [] as [string, unknown][], gte: [] as unknown[], lt: [] as unknown[], ranges: [] as [number, number][] };
    const page = (from: number) => (from === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}` })) : [{ id: "last" }]);
    const q: Record<string, unknown> = {
      select: (s: string) => { rec.select = s; return q; },
      eq: (c: string, v: unknown) => { rec.eqs.push([c, v]); return q; },
      neq: (c: string, v: unknown) => { rec.neqs.push([c, v]); return q; },
      gte: (c: string, v: unknown) => { rec.gte = [c, v]; return q; },
      lt: (c: string, v: unknown) => { rec.lt = [c, v]; return q; },
      order: () => q,
      range: (from: number, to: number) => { rec.ranges.push([from, to]); return Promise.resolve({ data: page(from), error: null }); },
    };
    const db = { from: (table: string) => { rec.table = table; return q; } };

    const rows = await fetchCalendarTasks(db as unknown as Parameters<typeof fetchCalendarTasks>[0], "tenant-1", "2026-11");

    expect(rec.table).toBe("tasks");
    expect(rec.select).toBe(TASK_SELECT);
    expect(rec.eqs).toContainEqual(["tenant_id", "tenant-1"]);
    expect(rec.neqs).toContainEqual(["status", "cancelled"]);
    expect(rec.gte).toEqual(["due_at", "2026-10-25T18:30:00.000Z"]);
    expect(rec.lt).toEqual(["due_at", "2026-12-06T18:30:00.000Z"]);
    expect(rows).toHaveLength(1001);                    // second page read too — nothing cut at 1000
    expect(rec.ranges.length).toBeGreaterThanOrEqual(2);
  });

  it("lives under the [\"tasks\"] cache key, so every task save refreshes the calendar", () => {
    expect(calendarTasksKey("tenant-1", "2026-11")).toEqual(["tasks", "calendar", "tenant-1", "2026-11"]);
  });
});
