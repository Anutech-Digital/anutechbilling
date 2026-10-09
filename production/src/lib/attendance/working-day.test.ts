import { describe, it, expect } from "vitest";
import {
  isWorkingDay, isoDowOf, SIX_DAY_WEEK_SUNDAY_OFF, type IsoDow,
} from "./working-day";

/* Real dates around the report. 23 Aug 2026 IS a Sunday — confirmed against the database
   (`extract(isodow) = 7`), not assumed from a calculation in my head. */
const SUN = "2026-08-23";
const SAT = "2026-08-22";
const MON = "2026-08-24";

describe("isoDowOf", () => {
  it("gets the real days right", () => {
    expect(isoDowOf(SUN)).toBe(7);
    expect(isoDowOf(SAT)).toBe(6);
    expect(isoDowOf(MON)).toBe(1);
  });

  it("does not slip a day on a timezone boundary", () => {
    /* Parsed at UTC noon on purpose. `new Date("2026-08-23")` is midnight UTC — the 23rd
       in IST but the 22nd in a negative-offset timezone, and a server that decides Sunday
       is Saturday would nudge the whole company on their day off. */
    expect(isoDowOf("2026-01-01")).toBe(4);   // Thursday
    expect(isoDowOf("2026-12-31")).toBe(4);   // Thursday
    expect(isoDowOf("2026-03-01")).toBe(7);   // Sunday
  });

  it("returns null for anything that is not a plain date", () => {
    for (const v of ["", "23-08-2026", "2026-8-3", "2026-08-23T10:00:00Z", "not a date"]) {
      expect(isoDowOf(v), v).toBeNull();
    }
  });
});

describe("isWorkingDay — ANUTECH's six-day week", () => {
  const off = SIX_DAY_WEEK_SUNDAY_OFF;

  it("says Sunday is not a working day — the reported bug", () => {
    const r = isWorkingDay({ date: SUN, weeklyOffDows: off });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("Sunday");
  });

  it("says SATURDAY IS a working day", () => {
    /* Confirmed by the operator. Getting this wrong in the other direction would go
       silent on a day the whole company is working, which is the worse failure — a
       missing check-in nobody was reminded about becomes a payroll query. */
    const r = isWorkingDay({ date: SAT, weeklyOffDows: off });
    expect(r.working).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("says Monday to Friday are working days", () => {
    for (const d of ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]) {
      expect(isWorkingDay({ date: d, weeklyOffDows: off }).working, d).toBe(true);
    }
  });
});

describe("isWorkingDay — holidays", () => {
  const off = SIX_DAY_WEEK_SUNDAY_OFF;

  it("skips a company holiday on an ordinary working day", () => {
    /* public.holidays has held tenant_id / holiday_date / name all along, and nothing in
       the reminder path ever read it. */
    const r = isWorkingDay({ date: MON, weeklyOffDows: off, holidayDates: [MON] });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("company holiday");
  });

  it("reports a holiday that lands on a weekly off AS the holiday", () => {
    /* Whoever reads the log is looking for the holiday, not the weekday. */
    const r = isWorkingDay({ date: SUN, weeklyOffDows: off, holidayDates: [SUN] });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("company holiday");
  });

  it("is unaffected by holidays on other dates", () => {
    const r = isWorkingDay({ date: MON, weeklyOffDows: off, holidayDates: [SUN, "2026-10-20"] });
    expect(r.working).toBe(true);
  });

  it("treats an empty or absent holiday list as no holidays", () => {
    expect(isWorkingDay({ date: MON, weeklyOffDows: off, holidayDates: [] }).working).toBe(true);
    expect(isWorkingDay({ date: MON, weeklyOffDows: off }).working).toBe(true);
  });
});

describe("isWorkingDay — other week shapes", () => {
  it("supports a five-day week", () => {
    const off: IsoDow[] = [6, 7];
    expect(isWorkingDay({ date: SAT, weeklyOffDows: off }).working).toBe(false);
    expect(isWorkingDay({ date: SUN, weeklyOffDows: off }).working).toBe(false);
    expect(isWorkingDay({ date: MON, weeklyOffDows: off }).working).toBe(true);
  });

  it("supports a seven-day week", () => {
    expect(isWorkingDay({ date: SUN, weeklyOffDows: [] }).working).toBe(true);
  });
});

describe("isWorkingDay — fails closed", () => {
  it("refuses to call an unreadable date a working day", () => {
    /* Defaulting to "working" is how a nudge goes out on a Sunday because a string
       arrived in the wrong format. Silence on a real working day is recoverable; the
       whole company nudged on their day off is what was reported. */
    const r = isWorkingDay({ date: "23/08/2026", weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("Could not read");
  });

  it("always explains itself when it says no", () => {
    const nos = [
      isWorkingDay({ date: SUN, weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF }),
      isWorkingDay({ date: MON, weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF, holidayDates: [MON] }),
      isWorkingDay({ date: "bad", weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF }),
    ];
    for (const r of nos) {
      expect(r.working).toBe(false);
      expect((r.reason ?? "").length).toBeGreaterThan(10);
    }
  });
});

describe("isWorkingDay — national gazetted holidays (R-602)", () => {
  /* Payroll has always treated 26 Jan / 15 Aug / 2 Oct as paid holidays
     (lib/payroll/holidays-india.ts), but the reminder path only knew weekly offs and the
     tenant's own `holidays` rows — so the "check in" nudge fired on Gandhi Jayanti.
     2 Oct 2026 is a Friday: an ordinary working weekday apart from the holiday. */
  const off = SIX_DAY_WEEK_SUNDAY_OFF;

  it("2 Oct 2026 (a Friday) is not a working day, with no company holiday row", () => {
    expect(isoDowOf("2026-10-02")).toBe(5);
    const r = isWorkingDay({ date: "2026-10-02", weeklyOffDows: off });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("Gandhi Jayanti");
  });

  it("26 Jan and 15 Aug are skipped too, in any year", () => {
    for (const d of ["2026-01-26", "2027-08-15", "2030-01-26"]) {
      expect(isWorkingDay({ date: d, weeklyOffDows: off }).working, d).toBe(false);
    }
  });

  it("the day after a national holiday is still a working day", () => {
    expect(isWorkingDay({ date: "2026-10-03", weeklyOffDows: off }).working).toBe(true);
  });

  it("a company holiday on the same date reads as the company holiday", () => {
    const r = isWorkingDay({ date: "2026-10-02", weeklyOffDows: off, holidayDates: ["2026-10-02"] });
    expect(r.working).toBe(false);
    expect(r.reason).toContain("company holiday");
  });
});
