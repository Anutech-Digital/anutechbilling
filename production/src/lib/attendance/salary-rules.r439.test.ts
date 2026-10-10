/**
 * R-439 (Pardeep 8 Oct, Haan 10 Oct) — salary rules for late / half day.
 *
 * The card's own example and every boundary of the ONE rule function (shift.ts dayStatus)
 * that the register, My Attendance and payroll's loss-of-pay suggestion share, plus the
 * payroll 0.5 maths and a wiring check that payroll has no second copy of the rule.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dayStatus, type ShiftRules } from "./shift";
import { presentSummary, suggestedLopDays, type AttendanceDayRow } from "./lop";

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const D = "2026-10-09";
const R: ShiftRules = { shiftStart: "10:00", shiftEnd: "18:00", lateGraceMinutes: 15, halfDayUnderHours: 4 };
const row = (d: string, inT: string | null, outT: string | null, emp = "e1"): AttendanceDayRow => ({
  employee_id: emp, work_date: d, check_in: inT ? ist(d, inT) : null, check_out: outT ? ist(d, outT) : null,
});

describe("R-439 rules — late", () => {
  it("card example: start 10:00, grace 15 → arriving 10:20 is Late (by 20 min), still a full day", () => {
    const s = dayStatus(D, ist(D, "10:20"), ist(D, "18:30"), R);
    expect(s).toMatchObject({ late: true, lateByMinutes: 20, presentValue: 1 });
  });

  it("exactly at grace end 10:15:00 is on time; 10:15:59 too; 10:16 is late", () => {
    expect(dayStatus(D, ist(D, "10:15"), ist(D, "18:00"), R).late).toBe(false);
    expect(dayStatus(D, "2026-10-09T04:45:59.000Z", ist(D, "18:00"), R).late).toBe(false);
    expect(dayStatus(D, ist(D, "10:16"), ist(D, "18:00"), R)).toMatchObject({ late: true, lateByMinutes: 16 });
  });

  it("grace 0: 10:00 on time, 10:01 late by 1", () => {
    const g0 = { ...R, lateGraceMinutes: 0 };
    expect(dayStatus(D, ist(D, "10:00"), ist(D, "18:00"), g0).late).toBe(false);
    expect(dayStatus(D, ist(D, "10:01"), ist(D, "18:00"), g0)).toMatchObject({ late: true, lateByMinutes: 1 });
  });

  it("arriving early is never late", () => {
    expect(dayStatus(D, ist(D, "08:00"), ist(D, "18:00"), R)).toMatchObject({ late: false, lateByMinutes: 0 });
  });

  it("IST, not the machine's zone: 04:50Z is 10:20 IST → late (a UTC reading would say on time)", () => {
    expect(dayStatus(D, "2026-10-09T04:50:00.000Z", "2026-10-09T12:30:00.000Z", R).late).toBe(true);
  });
});

describe("R-439 rules — half day", () => {
  it("4 hours is the minimum for a full day: 3h59m → Half day 0.5; 4h00m and 4h01m → full 1", () => {
    expect(dayStatus(D, ist(D, "10:00"), ist(D, "13:59"), R)).toMatchObject({ halfDay: true, presentValue: 0.5, workedMinutes: 239 });
    expect(dayStatus(D, ist(D, "10:00"), ist(D, "14:00"), R)).toMatchObject({ halfDay: false, presentValue: 1, workedMinutes: 240 });
    expect(dayStatus(D, ist(D, "10:00"), ist(D, "14:01"), R)).toMatchObject({ halfDay: false, presentValue: 1 });
  });

  it("late AND short: counts 0.5, late still shown", () => {
    expect(dayStatus(D, ist(D, "15:00"), ist(D, "18:00"), R)).toMatchObject({ late: true, halfDay: true, presentValue: 0.5 });
  });

  it("no check-out: not a half day — hours unknown (null, not 0), counted full, flagged for the owner", () => {
    expect(dayStatus(D, ist(D, "10:20"), null, R)).toMatchObject({
      late: true, halfDay: false, noCheckOut: true, workedMinutes: null, presentValue: 1,
    });
  });

  it("overnight: in 20:00, out 02:00 next IST day = 6h, not negative, not a half day", () => {
    expect(dayStatus(D, ist(D, "20:00"), ist("2026-10-10", "02:00"), R)).toMatchObject({
      workedMinutes: 360, halfDay: false, leftEarly: false, presentValue: 1,
    });
  });

  it("overnight short: in 23:00, out 01:00 → 2h → half day", () => {
    expect(dayStatus(D, ist(D, "23:00"), ist("2026-10-10", "01:00"), R)).toMatchObject({ workedMinutes: 120, halfDay: true, presentValue: 0.5 });
  });

  it("the workspace's own half-day hours are used (5h minimum → 4h30m is a half day)", () => {
    expect(dayStatus(D, ist(D, "10:00"), ist(D, "14:30"), { ...R, halfDayUnderHours: 5 }).halfDay).toBe(true);
  });

  it("a Sunday / holiday with a check-in is judged by the same rules (worked = present)", () => {
    const SUN = "2026-10-11";
    expect(dayStatus(SUN, ist(SUN, "10:20"), ist(SUN, "12:00"), R)).toMatchObject({ late: true, halfDay: true, presentValue: 0.5 });
  });
});

describe("R-439 payroll LOP suggestion — half day = 0.5 day absent, late costs nothing", () => {
  it("26 working days, 24 full + 2 half days → present 25, LOP 1 (2 × 0.5)", () => {
    const rows: AttendanceDayRow[] = [];
    for (let d = 1; d <= 24; d++) rows.push(row(`2026-09-${String(d).padStart(2, "0")}`, "10:00", "18:00"));
    rows.push(row("2026-09-25", "10:00", "13:00"), row("2026-09-26", "14:00", "17:59"));
    const s = presentSummary(rows, "e1", R);
    expect(s).toMatchObject({ present: 25, halfDays: 2 });
    expect(suggestedLopDays({ expected: 26, present: s.present, paidLeave: 0, unpaidLeave: 0 })).toEqual({ absent: 1, lopDays: 1 });
  });

  it("one half day alone → exactly 0.5 LOP (not 0, not 1)", () => {
    const s = presentSummary([row("2026-09-01", "10:00", "12:00")], "e1", R);
    expect(suggestedLopDays({ expected: 1, present: s.present, paidLeave: 0, unpaidLeave: 0 }).lopDays).toBe(0.5);
  });

  it("10 late days with full hours → 0 LOP (late is shown, never deducted)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2026-09-${String(i + 1).padStart(2, "0")}`, "10:45", "19:00"));
    const s = presentSummary(rows, "e1", R);
    expect(s).toMatchObject({ present: 10, lateDays: 10, halfDays: 0 });
    expect(suggestedLopDays({ expected: 10, present: s.present, paidLeave: 0, unpaidLeave: 0 }).lopDays).toBe(0);
  });

  it("a half day covered by half a day of paid leave → 0 LOP", () => {
    const s = presentSummary([row("2026-09-01", "10:00", "12:00")], "e1", R);
    expect(suggestedLopDays({ expected: 1, present: s.present, paidLeave: 0.5, unpaidLeave: 0 }).lopDays).toBe(0);
  });
});

describe("R-439 — one rule function, used by register and payroll", () => {
  it("payroll screens import presentSummary + dayStatus and carry no second late / half-day formula", () => {
    const src = readFileSync("src/app/(app)/accounting/payroll/screens.tsx", "utf8");
    expect(src).toMatch(/from "@\/lib\/attendance\/lop"/);
    expect(src).toMatch(/from "@\/lib\/attendance\/shift"/);
    expect(src).not.toMatch(/halfDayUnderHours\s*\*\s*60/);
    expect(src).not.toMatch(/lateGraceMinutes\s*[+<>]/);
  });

  it("only the owner sees the Fix button (the database refuses everyone else too)", () => {
    const src = readFileSync("src/app/(app)/accounting/payroll/screens.tsx", "utf8");
    expect(src).toMatch(/const canFix = useCurrentUser\(\)\.data\?\.role === "owner"/);
    expect(src).not.toMatch(/ATTENDANCE_FIX_ROLES/);
  });
});
