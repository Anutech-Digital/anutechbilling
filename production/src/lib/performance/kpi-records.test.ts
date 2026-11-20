/**
 * R-2965 — every Scorecards KPI opens the records behind its number. One source of truth:
 * for every KPI the list's count (or sum, for Revenue) is the tile's number, including the
 * edge rules the score uses (renewal quotes, payment status, on-time boundary, no due date,
 * goal rows, attendance without check-in, logins with no employee).
 */
import { describe, expect, it } from "vitest";
import {
  BULK_MIN_ROWS, buildPerfRows, daysLate, emptyReason, isOnTime, kpiValue, recordsFor, sumAmounts,
  summariseActivity, wonOutsideWindow, type KpiKey, type PerfInputs, type PerfRow,
} from "./kpi-records";

const U = "u-asha", V = "u-ravi";

function inputs(over: Partial<PerfInputs> = {}): PerfInputs {
  return {
    leads: [
      { id: "l1", owner_id: U, value: 50000, stage: "won", updated_at: "2026-11-04T10:00:00+00:00", stage_changed_at: "2026-11-04T10:00:00+00:00", company: "Lead One" },
      { id: "l2", owner_id: U, value: 0, stage: "won", updated_at: "2026-11-09T10:00:00+00:00", stage_changed_at: "2026-08-01T10:00:00+00:00", company: "Old Win" },
      { id: "l3", owner_id: V, value: 900, stage: "won", updated_at: "2026-11-05T10:00:00+00:00" },
    ],
    quotes: [
      { id: "Q-1", owner_id: U, created_at: "2026-11-02T10:00:00+00:00", amount: 1000, status: "sent", customer_name: "C1" },
      { id: "Q-2", owner_id: U, created_at: "2026-11-03T10:00:00+00:00", amount: 2000, status: "accepted", is_renewal: true },
      { id: "Q-3", owner_id: V, created_at: "2026-11-03T10:00:00+00:00", amount: 10, status: "draft" },
    ],
    payments: [
      { id: "p1", recorded_by: V, amount: 64900, received_at: "2026-11-10T10:00:00+00:00", status: "received", quote_id: "Q-2" },
      { id: "p2", recorded_by: V, amount: 100.5, received_at: "2026-11-11T10:00:00+00:00", status: "received", quote_id: null, invoice_id: "INV-9" },
      { id: "p3", recorded_by: U, amount: null, received_at: "2026-11-12T10:00:00+00:00", status: "received", quote_id: "Q-1" },
    ],
    tasks: [
      { id: "t1", owner_id: U, status: "done", due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-05T10:00:00+00:00", title: "Exactly at due" },
      { id: "t2", owner_id: U, status: "done", due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-07T11:00:00+00:00", title: "Two days late" },
      { id: "t3", owner_id: U, status: "done", due_at: null, completed_at: "2026-11-08T10:00:00+00:00", title: "No due date" },
      { id: "t4", owner_id: V, status: "done", due_at: "2026-11-20T10:00:00+00:00", completed_at: "2026-11-01T10:00:00+00:00", title: "Early" },
    ],
    users: [{ id: U, employee_id: "e-asha" }, { id: V, employee_id: null }],
    attendance: [
      { id: "a1", employee_id: "e-asha", work_date: "2026-11-03", check_in: "2026-11-03T04:00:00+00:00" },
      { id: "a2", employee_id: "e-asha", work_date: "2026-11-04", check_in: null },
      { id: "a3", employee_id: "e-other", work_date: "2026-11-04", check_in: "2026-11-04T04:00:00+00:00" },
    ],
    activity: [
      { user_id: U, created_at: "2026-11-02T10:00:00+00:00", action: "update", entity: "leads" },
      { user_id: V, created_at: "2026-11-02T10:00:00+00:00", action: "insert", entity: "payments" },
      { user_id: null, created_at: "2026-11-02T10:00:00+00:00", action: "update", entity: "quotes" },
    ],
    kudos: [],
    renewalQuoteIds: new Set(["Q-2"]),
    ...over,
  };
}

const members = [{ id: U, name: "Asha", role: "sales" }, { id: V, name: "Ravi", role: "accountant" }];
const KPIS: KpiKey[] = ["revenue", "dealsWon", "quotes", "payments", "present", "tasksOnTime", "tasksLate", "activity"];

function listValue(row: PerfRow, kpi: KpiKey): number {
  const r = row.records!;
  switch (kpi) {
    case "revenue": return sumAmounts(r.revenue);
    case "dealsWon": return r.dealsWon.length;
    case "quotes": return r.quotes.length;
    case "payments": return r.payments.length;
    case "present": return r.present.length;
    case "tasksOnTime": return r.tasksOnTime.length;
    case "tasksLate": return r.tasksLate.length;
    case "activity": return r.activity.length;
  }
}

describe("R-2965: the list behind each tile adds up to the tile", () => {
  const rows = buildPerfRows(members, inputs());
  for (const kpi of KPIS) {
    it(`${kpi}: count/sum of its records == the tile number, for every person`, () => {
      for (const row of rows) expect(listValue(row, kpi)).toBe(kpiValue(row, kpi));
    });
  }

  it("the numbers are the score's own (same weights, same rules)", () => {
    const asha = rows.find((r) => r.userId === U)!;
    const ravi = rows.find((r) => r.userId === V)!;
    expect(asha).toMatchObject({ dealsWon: 2, quotesSent: 2, revenue: 0, paymentsCount: 1, tasksOnTime: 1, tasksLate: 2, presentDays: 1, activityCount: 1 });
    // 2 deals (80) + 2 quotes (10) + 1 payment (5) + 1 on time (3) − 2 late (2) = 96
    expect(asha.score).toBe(96);
    expect(ravi).toMatchObject({ dealsWon: 1, quotesSent: 1, revenue: 65000.5, paymentsCount: 2, tasksOnTime: 1, tasksLate: 0, presentDays: 0, renewalPayments: 1 });
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[1].score);
  });

  it("Revenue and Payments list the same payments (Revenue is their sum)", () => {
    const ravi = rows.find((r) => r.userId === V)!;
    expect(ravi.records!.revenue.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(ravi.records!.payments).toBe(ravi.records!.revenue);
  });

  it("renewal quotes count as Quotes like any other", () => {
    expect(recordsFor(U, inputs()).quotes.map((q) => q.id)).toEqual(["Q-1", "Q-2"]);
  });

  it("goal rows / not-done tasks never reach the lists (the read filters them; nothing re-adds them)", () => {
    const r = recordsFor(U, inputs());
    expect([...r.tasksOnTime, ...r.tasksLate].map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });
});

describe("one pass over the inputs", () => {
  it("a big team: every person's lists are theirs only and add up to all rows", () => {
    const people = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, name: `P${i}`, role: "sales" }));
    const activity = Array.from({ length: 20_000 }, (_, i) => ({ user_id: `u${i % 40}`, created_at: `2026-11-02T10:00:${String(i % 60).padStart(2, "0")}+00:00` }));
    const t0 = performance.now();
    const rows = buildPerfRows(people, inputs({ activity, users: people.map((p) => ({ id: p.id, employee_id: null })) }));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(rows.reduce((s, r) => s + r.activityCount, 0)).toBe(20_000);
    for (const r of rows) expect(r.records!.activity.every((a) => a.user_id === r.userId)).toBe(true);
  });
});

describe("edge rules", () => {
  it("completed exactly at the due instant is on time; a task with no due date counts as late", () => {
    expect(isOnTime({ completed_at: "2026-11-05T10:00:00+00:00", due_at: "2026-11-05T10:00:00+00:00" })).toBe(true);
    expect(isOnTime({ completed_at: "2026-11-05T10:00:01+00:00", due_at: "2026-11-05T10:00:00+00:00" })).toBe(false);
    const r = recordsFor(U, inputs());
    expect(r.tasksOnTime.map((t) => t.id)).toEqual(["t1"]);
    expect(r.tasksLate.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  it("days late: IST calendar days from the due day to the completed day (0 = late on the due day)", () => {
    expect(daysLate({ due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-07T11:00:00+00:00" })).toBe(2);
    expect(daysLate({ due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-05T12:00:00+00:00" })).toBe(0);
    expect(daysLate({ due_at: "2026-11-05T10:00:00+00:00", completed_at: "2026-11-05T09:00:00+00:00" })).toBe(0);
    // 23:00 IST due, 01:00 IST next day done → 1 day, though only 2 hours late
    expect(daysLate({ due_at: "2026-11-05T17:30:00+00:00", completed_at: "2026-11-05T19:30:00+00:00" })).toBe(1);
    expect(daysLate({ due_at: null, completed_at: "2026-11-05T09:00:00+00:00" })).toBeNull();
  });

  it("attendance: only days with a check-in, only the linked employee; no linked employee → none", () => {
    expect(recordsFor(U, inputs()).present.map((a) => a.id)).toEqual(["a1"]);
    const ravi = recordsFor(V, inputs());
    expect(ravi.employeeId).toBeNull();
    expect(ravi.present).toEqual([]);
    expect(emptyReason("present", "Ravi", "November 2026", { employeeLinked: false })).toMatch(/not linked to an employee/);
  });

  it("a lead won months ago but edited this month is counted — and flagged", () => {
    const deals = recordsFor(U, inputs()).dealsWon;
    expect(deals.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(deals.map((l) => wonOutsideWindow(l, "2026-11"))).toEqual([false, true]);
    // won 1 Nov 02:00 IST (31 Oct 20:30 UTC) is a November win in IST — not flagged
    expect(wonOutsideWindow({ stage_changed_at: "2026-10-31T20:30:00+00:00" }, "2026-11")).toBe(false);
    expect(wonOutsideWindow({ stage_changed_at: "2026-10-31T18:00:00+00:00" }, "2026-11")).toBe(true);
  });

  it("a payment with no amount adds 0 to Revenue but is one Payment", () => {
    const r = recordsFor(U, inputs());
    expect(r.payments).toHaveLength(1);
    expect(sumAmounts(r.revenue)).toBe(0);
  });

  it("empty reasons name the person and the month", () => {
    expect(emptyReason("payments", "Asha", "November 2026")).toBe("No payments recorded by Asha in November 2026.");
    expect(emptyReason("tasksLate", "Asha", "November 2026")).toMatch(/Asha.*November 2026/);
  });
});

describe("Activity summary", () => {
  it("top types + other add up to the total; bulk writes (same instant, 10+) are apart", () => {
    const bulkAt = "2026-11-03T05:00:00.123+00:00";
    const rows = [
      ...Array.from({ length: BULK_MIN_ROWS + 2 }, () => ({ user_id: U, created_at: bulkAt, action: "update", entity: "bank_lines" })),
      ...Array.from({ length: 14 }, (_, i) => ({ user_id: U, created_at: `2026-11-04T05:00:${String(i).padStart(2, "0")}+00:00`, action: i < 3 ? "insert" : "update", entity: `t${i % 12}` })),
    ];
    const s = summariseActivity(rows);
    expect(s.total).toBe(26);
    expect(s.bulkCount).toBe(12);
    expect(s.bulkRuns).toBe(1);
    expect(s.ownCount).toBe(14);
    expect(s.top).toHaveLength(10);
    expect(s.top.reduce((a, t) => a + t.count, 0) + s.other.count).toBe(s.total);
    expect(s.top[0]).toMatchObject({ label: "Changed · bank lines", count: 12 });
    expect(s.bulkTop[0]).toMatchObject({ label: "Changed · bank lines", count: 12 });
  });

  it("nine rows at one instant are not bulk", () => {
    const rows = Array.from({ length: BULK_MIN_ROWS - 1 }, () => ({ user_id: U, created_at: "x", action: "insert", entity: "tasks" }));
    expect(summariseActivity(rows)).toMatchObject({ bulkCount: 0, ownCount: BULK_MIN_ROWS - 1, bulkRuns: 0 });
  });
});
