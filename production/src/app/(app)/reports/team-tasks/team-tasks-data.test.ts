import { describe, it, expect } from "vitest";
import { fetchTeamTasks } from "./team-tasks-data";
import { REPORT_TASK_SELECT } from "./team-tasks";

/* R-2932 — three tenant-scoped reads (open / done recently / due recently), merged once. */

type Rec = { select: string; eqs: [string, unknown][]; ins: [string, unknown][]; gtes: [string, unknown][] };

describe("R-2932 fetchTeamTasks", () => {
  it("reads open tasks and the last 8 weeks of done ones for one tenant, each task once", async () => {
    const calls: Rec[] = [];
    const db = {
      from: (table: string) => {
        expect(table).toBe("tasks");
        const rec: Rec = { select: "", eqs: [], ins: [], gtes: [] };
        calls.push(rec);
        const rows = () =>
          rec.ins.length ? [{ id: "open-1" }, { id: "open-2" }]
          : rec.gtes[0]?.[0] === "completed_at" ? [{ id: "done-1" }, { id: "done-2" }]
          : [{ id: "done-2" }, { id: "done-3" }];
        const q: Record<string, unknown> = {
          select: (s: string) => { rec.select = s; return q; },
          eq: (c: string, v: unknown) => { rec.eqs.push([c, v]); return q; },
          in: (c: string, v: unknown) => { rec.ins.push([c, v]); return q; },
          gte: (c: string, v: unknown) => { rec.gtes.push([c, v]); return q; },
          order: () => q,
          range: () => Promise.resolve({ data: rows(), error: null }),
        };
        return q;
      },
    };

    const out = await fetchTeamTasks(db as unknown as Parameters<typeof fetchTeamTasks>[0], "tenant-1", new Date("2026-11-18T06:30:00Z"));

    expect(out.map((t) => t.id)).toEqual(["open-1", "open-2", "done-1", "done-2", "done-3"]);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.select).toBe(REPORT_TASK_SELECT);
      expect(c.eqs).toContainEqual(["tenant_id", "tenant-1"]);
    }
    expect(calls.find((c) => c.ins.length)!.ins[0]).toEqual(["status", ["pending", "snoozed"]]);
    const done = calls.filter((c) => c.gtes.length);
    expect(done.map((c) => c.gtes[0]).sort()).toEqual([
      ["completed_at", "2026-09-27T18:30:00.000Z"],
      ["due_at", "2026-09-27T18:30:00.000Z"],
    ]);
    for (const c of done) expect(c.eqs).toContainEqual(["status", "done"]);
  });

  it("reads only the five columns the counts need — no task text, no customer", () => {
    expect(REPORT_TASK_SELECT).toBe("id, owner_id, status, due_at, completed_at");
  });
});
