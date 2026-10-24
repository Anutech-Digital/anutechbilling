import { describe, expect, it } from "vitest";
import { leaveDaysInMonth, presentByDate, presentSummary, suggestedLopDays, type AttendanceDayRow, type LeaveRow } from "./lop";
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

describe("R-780 leaveDaysInMonth — leave counts only its working days inside this month, never on a present day, never twice", () => {
  const OCT_HOLIDAYS = new Set(["2026-10-02"]);
  const isWorking = (holidays: ReadonlySet<string>) => (iso: string) =>
    new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0 && !holidays.has(iso);
  const octDates = (holidays: ReadonlySet<string>) => {
    const s = new Set<string>();
    for (let d = 1; d <= 31; d++) {
      const iso = `2026-10-${String(d).padStart(2, "0")}`;
      if (isWorking(holidays)(iso)) s.add(iso);
    }
    return s;
  };
  const leave = (from: string, to: string, days: number, type = "casual", emp = "e1"): LeaveRow =>
    ({ employee_id: emp, from_date: from, to_date: to, days, type });
  const run = (leaves: LeaveRow[], present: Record<string, number> = {}, holidays: ReadonlySet<string> = OCT_HOLIDAYS) =>
    leaveDaysInMonth({
      leaves, employeeId: "e1", countedDates: octDates(holidays),
      isWorkingDate: isWorking(holidays), presentByDate: new Map(Object.entries(present)),
    });

  it("28 Sep–3 Oct casual (5 working days) → October counts only 1 Oct and 3 Oct (2 Oct holiday)", () => {
    expect(run([leave("2026-09-28", "2026-10-03", 5)])).toEqual({ paidLeave: 2, unpaidLeave: 0 });
  });
  it("same leave without the 2 Oct holiday → October counts its 3 days (1–3 Oct), not all 6", () => {
    expect(run([leave("2026-09-28", "2026-10-03", 6)], {}, new Set())).toEqual({ paidLeave: 3, unpaidLeave: 0 });
  });
  it("a day marked present inside the leave is not counted as leave", () => {
    expect(run([leave("2026-10-05", "2026-10-07", 3)], { "2026-10-06": 1 })).toEqual({ paidLeave: 2, unpaidLeave: 0 });
  });
  it("a half-day present + a full-day leave on that day → only the other half is leave", () => {
    expect(run([leave("2026-10-05", "2026-10-05", 1, "unpaid")], { "2026-10-05": 0.5 })).toEqual({ paidLeave: 0, unpaidLeave: 0.5 });
  });
  it("two overlapping leave entries never count a day twice", () => {
    expect(run([leave("2026-10-05", "2026-10-06", 2), leave("2026-10-06", "2026-10-07", 2)]))
      .toEqual({ paidLeave: 3, unpaidLeave: 0 });
  });
  it("half-day leave counts 0.5", () => {
    expect(run([leave("2026-10-08", "2026-10-08", 0.5)])).toEqual({ paidLeave: 0.5, unpaidLeave: 0 });
  });
  it("leave on a Sunday or holiday counts nothing", () => {
    expect(run([leave("2026-10-04", "2026-10-04", 1), leave("2026-10-02", "2026-10-02", 1, "unpaid")]))
      .toEqual({ paidLeave: 0, unpaidLeave: 0 });
  });
  it("a leave wholly inside the month on working days counts as before; unpaid stays unpaid; other employees ignored", () => {
    expect(run([leave("2026-10-05", "2026-10-07", 3), leave("2026-10-12", "2026-10-13", 2, "unpaid"), leave("2026-10-14", "2026-10-14", 1, "casual", "e2")]))
      .toEqual({ paidLeave: 3, unpaidLeave: 2 });
  });
  it("days payroll does not count yet (after today / before joining) are not counted", () => {
    const r = leaveDaysInMonth({
      leaves: [leave("2026-10-15", "2026-10-17", 3, "unpaid")], employeeId: "e1",
      countedDates: new Set(["2026-10-15"]), isWorkingDate: isWorking(OCT_HOLIDAYS), presentByDate: new Map(),
    });
    expect(r).toEqual({ paidLeave: 0, unpaidLeave: 1 });
  });
  it("feeds suggestedLopDays: 26 working days, 23 present, leave 28 Sep–3 Oct → 1 absent, not 0", () => {
    const { paidLeave, unpaidLeave } = run([leave("2026-09-28", "2026-10-03", 5)]);
    expect(suggestedLopDays({ expected: 26, present: 23, paidLeave, unpaidLeave })).toEqual({ absent: 1, lopDays: 1 });
  });
});

describe("presentByDate — the per-day present value leaveDaysInMonth needs", () => {
  it("full day 1, short day 0.5, other employee and no check-in ignored", () => {
    const m = presentByDate([
      row("2026-10-05", "10:00", "18:00"), row("2026-10-06", "10:00", "12:00"),
      row("2026-10-07", null, null), row("2026-10-08", "10:00", "18:00", "e2"),
    ], "e1", DEFAULT_SHIFT);
    expect([...m.entries()]).toEqual([["2026-10-05", 1], ["2026-10-06", 0.5]]);
  });
});

describe("R-780 payroll screen uses leaveDaysInMonth, not the whole leave.days", () => {
  it("no fixed `${period}-31` leave filter and no raw sum of l.days for the LOP suggestion", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "accounting", "payroll", "screens.tsx"), "utf8");
    expect(src).not.toMatch(/from_date <= `\$\{period\}-31`/);
    expect(src).toMatch(/leaveDaysInMonth\(/);
  });
});
