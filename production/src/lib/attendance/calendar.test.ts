import { describe, it, expect } from "vitest";
import { expectedWorkingDays } from "./calendar";
import { SIX_DAY_WEEK_SUNDAY_OFF, type IsoDow } from "./working-day";
import { nationalHolidaysForYear } from "@/lib/payroll/holidays-india";
import { utcDateISO } from "@/lib/dates/ist";

const SUN_OFF = SIX_DAY_WEEK_SUNDAY_OFF;

describe("expectedWorkingDays — whole months", () => {
  it("October 2026: 4 Sundays + Gandhi Jayanti (Fri 2 Oct) → 26 working days", () => {
    expect(expectedWorkingDays({ period: "2026-10", todayIST: "2026-11-15", weeklyOffDows: SUN_OFF }))
      .toEqual({ expected: 26, weeklyOffs: 4, holidays: 1 });
  });

  it("counts a company holiday on a weekday, ignores holidays in other months", () => {
    expect(expectedWorkingDays({
      period: "2026-10", todayIST: "2026-11-15", weeklyOffDows: SUN_OFF,
      holidayDates: ["2026-10-20", "2026-11-10"],
    })).toEqual({ expected: 25, weeklyOffs: 4, holidays: 2 });
  });

  it("a holiday on a Sunday counts ONCE, as the weekly off (15 Aug 2027 is a Sunday)", () => {
    expect(expectedWorkingDays({
      period: "2027-08", todayIST: "2027-09-01", weeklyOffDows: SUN_OFF, holidayDates: ["2027-08-15"],
    })).toEqual({ expected: 26, weeklyOffs: 5, holidays: 0 });
  });

  it("February 2028 (leap year, 29 days) → 25 working days", () => {
    expect(expectedWorkingDays({ period: "2028-02", todayIST: "2028-03-01", weeklyOffDows: SUN_OFF }))
      .toEqual({ expected: 25, weeklyOffs: 4, holidays: 0 });
  });

  it("February 2026 (28 days) → 24 working days", () => {
    expect(expectedWorkingDays({ period: "2026-02", todayIST: "2026-03-01", weeklyOffDows: SUN_OFF }))
      .toEqual({ expected: 24, weeklyOffs: 4, holidays: 0 });
  });

  it("supports a five-day week", () => {
    expect(expectedWorkingDays({ period: "2026-10", todayIST: "2026-11-15", weeklyOffDows: [6, 7] }))
      .toEqual({ expected: 21, weeklyOffs: 9, holidays: 1 });
  });
});

describe("expectedWorkingDays — range", () => {
  it("current month stops at today (IST): 1–9 Oct 2026 → 7", () => {
    expect(expectedWorkingDays({ period: "2026-10", todayIST: "2026-10-09", weeklyOffDows: SUN_OFF }))
      .toEqual({ expected: 7, weeklyOffs: 1, holidays: 1 });
  });

  it("mid-month joiner starts on the joining date: joined 15 Oct 2026 → 15", () => {
    expect(expectedWorkingDays({
      period: "2026-10", joiningDate: "2026-10-15", todayIST: "2026-11-15", weeklyOffDows: SUN_OFF,
    })).toEqual({ expected: 15, weeklyOffs: 2, holidays: 0 });
  });

  it("a joining date before the month changes nothing", () => {
    expect(expectedWorkingDays({
      period: "2026-10", joiningDate: "2024-04-01", todayIST: "2026-11-15", weeklyOffDows: SUN_OFF,
    }).expected).toBe(26);
  });

  it("future month → all zero", () => {
    expect(expectedWorkingDays({ period: "2026-12", todayIST: "2026-10-09", weeklyOffDows: SUN_OFF }))
      .toEqual({ expected: 0, weeklyOffs: 0, holidays: 0 });
  });

  it("joining date after today → all zero", () => {
    expect(expectedWorkingDays({
      period: "2026-10", joiningDate: "2026-10-20", todayIST: "2026-10-09", weeklyOffDows: SUN_OFF,
    })).toEqual({ expected: 0, weeklyOffs: 0, holidays: 0 });
  });

  it("an unreadable period → all zero, never a guess", () => {
    for (const p of ["", "2026-13", "10-2026", "2026-1"]) {
      expect(expectedWorkingDays({ period: p, todayIST: "2026-10-09", weeklyOffDows: SUN_OFF }), p)
        .toEqual({ expected: 0, weeklyOffs: 0, holidays: 0 });
    }
  });
});

/* ─── Payroll parity (spec pin) ──────────────────────────────────────────────────────────
   A verbatim copy of the day loop inside `lopSuggestion` in
   app/(app)/accounting/payroll/screens.tsx (as of R-602; that file is NOT changed here).
   It runs with today passed in instead of `todayISO()`. If the helper ever disagrees with
   it for any month/joiner, switching payroll to the helper would move a rupee — so this
   must stay green until Pardeep approves that switch. */
function payrollLoopToday(period: string, joining: string | null, today: string, companyHolidays: string[]) {
  const [yy, mm] = period.split("-").map(Number);
  const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0));
  const todayUTC = new Date(today + "T00:00:00Z");
  const rangeEnd = todayUTC < monthEnd ? todayUTC : monthEnd;
  const rangeStart = joining && joining > `${period}-01` ? new Date(joining + "T00:00:00Z") : monthStart;
  const holidaySet = new Set(companyHolidays);
  nationalHolidaysForYear(yy).forEach((d) => holidaySet.add(d));
  let expected = 0, sundays = 0, holidays = 0;
  for (const d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = utcDateISO(d);
    if (d.getUTCDay() === 0) sundays++;
    else if (holidaySet.has(iso)) holidays++;
    else expected++;
  }
  return { expected, weeklyOffs: sundays, holidays };
}

describe("expectedWorkingDays — matches payroll's lopSuggestion loop exactly", () => {
  const company = ["2026-03-04", "2026-10-20", "2026-11-08", "2027-08-15", "2028-02-29"];
  const todays = ["2026-10-09", "2026-12-31", "2028-03-15"];
  const joiners: (string | null)[] = [null, "2025-01-01", "2026-10-02", "2026-10-15", "2028-02-29"];
  const off: readonly IsoDow[] = [7];

  it("for every month 2026-01 … 2028-12, several joiners and todays", () => {
    let checked = 0;
    for (let y = 2026; y <= 2028; y++) {
      for (let mth = 1; mth <= 12; mth++) {
        const period = `${y}-${String(mth).padStart(2, "0")}`;
        for (const today of todays) {
          for (const joining of joiners) {
            const want = payrollLoopToday(period, joining, today, company);
            const got = expectedWorkingDays({ period, joiningDate: joining, todayIST: today, holidayDates: company, weeklyOffDows: off });
            expect(got, `${period} join=${joining} today=${today}`).toEqual(want);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(36 * 3 * 5);
  });
});

/* ─── Current LOP arithmetic, pinned as a documented spec ────────────────────────────────
   Copied from `lopSuggestion` (screens.tsx). NOT production code — it records what payroll
   suggests TODAY, including two known bugs, so any fix is a visible, deliberate change
   (needs Pardeep's OK — it moves salary).

   BUG 1: a leave that spans two months adds its FULL `days` to this month.
   BUG 2: a leave on a day the person was present, or on a holiday / Sunday, is still
          subtracted from expected — so absent (= LOP) is undercounted. */
interface Leave { from_date: string; to_date: string; days: number; type: string }
function currentLopSpec(period: string, expected: number, present: number, leaves: Leave[]) {
  const monthLeaves = leaves.filter((l) => l.from_date <= `${period}-31` && l.to_date >= `${period}-01`);
  const paidLeave = monthLeaves.filter((l) => l.type !== "unpaid").reduce((s, l) => s + l.days, 0);
  const unpaidLeave = monthLeaves.filter((l) => l.type === "unpaid").reduce((s, l) => s + l.days, 0);
  const absent = Math.max(0, expected - present - paidLeave - unpaidLeave);
  return { absent, unpaidLeave, lopDays: absent + unpaidLeave };
}

describe("current payroll LOP suggestion (spec pin, R-602)", () => {
  const expected = expectedWorkingDays({ period: "2026-10", todayIST: "2026-11-15", weeklyOffDows: [7] }).expected; // 26

  it("absent = expected − present − leave; LOP = absent + unpaid leave", () => {
    expect(currentLopSpec("2026-10", expected, 20, [
      { from_date: "2026-10-05", to_date: "2026-10-06", days: 2, type: "casual" },
      { from_date: "2026-10-12", to_date: "2026-10-12", days: 1, type: "unpaid" },
    ])).toEqual({ absent: 3, unpaidLeave: 1, lopDays: 4 });
  });

  it("never goes below zero absent", () => {
    expect(currentLopSpec("2026-10", expected, 26, [
      { from_date: "2026-10-05", to_date: "2026-10-05", days: 1, type: "casual" },
    ])).toEqual({ absent: 0, unpaidLeave: 0, lopDays: 0 });
  });

  it("KNOWN BUG 1 (pinned): leave 28 Sep – 3 Oct (6 days) counts all 6 in October", () => {
    const r = currentLopSpec("2026-10", expected, 15, [
      { from_date: "2026-09-28", to_date: "2026-10-03", days: 6, type: "casual" },
    ]);
    /* Correct would be 2 (1 + 3 Oct; 2 Oct is a holiday) → absent 9. Today it is 5. */
    expect(r.absent).toBe(5);
  });

  it("KNOWN BUG 2 (pinned): leave on a present day / holiday still reduces absent", () => {
    /* 25 present + 1-day casual leave on 2 Oct (a holiday): only 1 real absence, but the
       leave is subtracted anyway, so LOP shows 0. */
    const r = currentLopSpec("2026-10", expected, 25, [
      { from_date: "2026-10-02", to_date: "2026-10-02", days: 1, type: "casual" },
    ]);
    expect(r.absent).toBe(0);
  });
});
