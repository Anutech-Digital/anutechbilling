import { describe, expect, it } from "vitest";
import { presentSummary, suggestedLopDays, type AttendanceDayRow } from "./lop";
import { DEFAULT_SHIFT } from "./shift";

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const row = (d: string, inT: string | null, outT: string | null, emp = "e1"): AttendanceDayRow => ({
  employee_id: emp, work_date: d, check_in: inT ? ist(d, inT) : null, check_out: outT ? ist(d, outT) : null,
});

describe("presentSummary — Pardeep 9 Oct: half-day under 4h counts 0.5", () => {
  it("full days count 1, a 3h59m day 0.5, exactly 4h counts 1", () => {
    const s = presentSummary([
      row("2026-10-05", "10:00", "18:00"),
      row("2026-10-06", "10:00", "13:59"),
      row("2026-10-07", "10:00", "14:00"),
    ], "e1", DEFAULT_SHIFT);
    expect(s.present).toBe(2.5);
    expect(s.halfDays).toBe(1);
  });

  it("no check-out counts a full day and is counted for the owner", () => {
    const s = presentSummary([row("2026-10-05", "11:00", null)], "e1", DEFAULT_SHIFT);
    expect(s).toEqual({ present: 1, halfDays: 0, lateDays: 1, noCheckOutDays: 1 });
  });

  it("late never reduces the count — shown only", () => {
    const s = presentSummary([row("2026-10-05", "12:30", "19:00")], "e1", DEFAULT_SHIFT);
    expect(s.present).toBe(1);
    expect(s.lateDays).toBe(1);
  });

  it("ignores other employees, rows without a check-in, and a duplicate date", () => {
    const s = presentSummary([
      row("2026-10-05", "10:00", "18:00"),
      row("2026-10-05", "10:00", "11:00"),
      row("2026-10-06", null, null),
      row("2026-10-07", "10:00", "18:00", "e2"),
    ], "e1", DEFAULT_SHIFT);
    expect(s.present).toBe(1);
  });

  it("matches the pre-R-604 count when nobody has a half-day", () => {
    const rows = ["01", "02", "03", "05", "06"].map((d) => row(`2026-10-${d}`, "09:55", "18:05"));
    const before = new Set(rows.filter((r) => r.employee_id === "e1" && r.check_in).map((r) => r.work_date)).size;
    expect(presentSummary(rows, "e1", DEFAULT_SHIFT).present).toBe(before);
  });
});

describe("suggestedLopDays — same arithmetic as before, now with halves", () => {
  it("one half-day in a 26-day month with 25 full days → 0.5 LOP", () => {
    expect(suggestedLopDays({ expected: 26, present: 25.5, paidLeave: 0, unpaidLeave: 0 }))
      .toEqual({ absent: 0.5, lopDays: 0.5 });
  });
  it("paid leave covers an absence; unpaid leave is added on top", () => {
    expect(suggestedLopDays({ expected: 26, present: 23.5, paidLeave: 1, unpaidLeave: 1 }))
      .toEqual({ absent: 0.5, lopDays: 1.5 });
  });
  it("never negative", () => {
    expect(suggestedLopDays({ expected: 10, present: 12, paidLeave: 0, unpaidLeave: 0 }))
      .toEqual({ absent: 0, lopDays: 0 });
  });
  it("₹30,000 in a 30-day month: half a day = ₹500 (payroll's own per-day rule)", () => {
    const { lopDays } = suggestedLopDays({ expected: 26, present: 25.5, paidLeave: 0, unpaidLeave: 0 });
    expect(Math.round((30000 / 30) * lopDays)).toBe(500);
  });
});

describe("payroll's attendance query uses the real month end (R-604 bug found in the browser)", () => {
  it("never filters work_date with a fixed day 31 — Postgres rejects 2026-09-31 and the month loads empty", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src", "lib", "queries", "payroll.ts"), "utf8");
    expect(src).not.toMatch(/\.lte\("work_date",\s*`\$\{period\}-31`\)/);
    expect(src).toMatch(/monthBounds\(period\)/);
  });
});
