import { describe, expect, it } from "vitest";
import { DEFAULT_SHIFT, dayStatus, formatGap, istMinuteOfDay, parseShiftRules, validateShiftInput } from "./shift";

/** IST wall-clock → ISO instant. 2026-10-09 10:00 IST = 04:30Z. */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const D = "2026-10-09";

describe("istMinuteOfDay", () => {
  it("reads IST wall-clock minutes, not UTC", () => {
    expect(istMinuteOfDay(ist(D, "10:00"), D)).toBe(600);
    expect(istMinuteOfDay("2026-10-09T04:30:00.000Z", D)).toBe(600);
  });
  it("counts past midnight for a check-out on the next IST day", () => {
    expect(istMinuteOfDay(ist("2026-10-10", "00:30"), D)).toBe(24 * 60 + 30);
  });
});

describe("dayStatus — Pardeep's rules (9 Oct 2026): 10:00–18:00, late after 10:15, half-day under 4h", () => {
  it("absent: no check-in counts 0", () => {
    const s = dayStatus(D, null, null, DEFAULT_SHIFT);
    expect(s).toMatchObject({ present: false, presentValue: 0, late: false, halfDay: false });
  });

  it("on time at 10:15 exactly — grace includes the 15th minute", () => {
    const s = dayStatus(D, ist(D, "10:15"), ist(D, "18:00"), DEFAULT_SHIFT);
    expect(s.late).toBe(false);
    expect(s.presentValue).toBe(1);
  });

  it("late at 10:16, late-by counted from 10:00", () => {
    const s = dayStatus(D, ist(D, "10:16"), ist(D, "18:30"), DEFAULT_SHIFT);
    expect(s.late).toBe(true);
    expect(s.lateByMinutes).toBe(16);
    expect(s.presentValue).toBe(1); // late is shown only — never docked
  });

  it("left early before 18:00", () => {
    const s = dayStatus(D, ist(D, "10:00"), ist(D, "17:20"), DEFAULT_SHIFT);
    expect(s.leftEarly).toBe(true);
    expect(s.leftEarlyByMinutes).toBe(40);
    expect(s.workedMinutes).toBe(440);
  });

  it("half-day at 3h59m → 0.5", () => {
    const s = dayStatus(D, ist(D, "10:00"), ist(D, "13:59"), DEFAULT_SHIFT);
    expect(s.halfDay).toBe(true);
    expect(s.presentValue).toBe(0.5);
  });

  it("exactly 4h is a full day", () => {
    const s = dayStatus(D, ist(D, "10:00"), ist(D, "14:00"), DEFAULT_SHIFT);
    expect(s.halfDay).toBe(false);
    expect(s.presentValue).toBe(1);
  });

  it("no check-out: hours unknown → counted full, flagged for the owner to fix", () => {
    const s = dayStatus(D, ist(D, "11:30"), null, DEFAULT_SHIFT);
    expect(s.noCheckOut).toBe(true);
    expect(s.workedMinutes).toBeNull();
    expect(s.halfDay).toBe(false);
    expect(s.presentValue).toBe(1);
    expect(s.late).toBe(true);
  });

  it("check-out past midnight is still one day's hours", () => {
    const s = dayStatus(D, ist(D, "10:00"), ist("2026-10-10", "00:30"), DEFAULT_SHIFT);
    expect(s.workedMinutes).toBe(14 * 60 + 30);
    expect(s.leftEarly).toBe(false);
  });

  it("uses the workspace's own rules when set", () => {
    const rules = { shiftStart: "09:30", shiftEnd: "17:30", lateGraceMinutes: 0, halfDayUnderHours: 5 };
    const s = dayStatus(D, ist(D, "09:31"), ist(D, "14:00"), rules);
    expect(s.late).toBe(true);
    expect(s.lateByMinutes).toBe(1);
    expect(s.halfDay).toBe(true); // 4h29m < 5h
  });
});

describe("parseShiftRules", () => {
  it("falls back to the default for a missing row", () => {
    expect(parseShiftRules(null)).toEqual(DEFAULT_SHIFT);
  });
  it("reads Postgres time strings (HH:MM:SS)", () => {
    expect(parseShiftRules({ shift_start: "09:30:00", shift_end: "18:30:00", late_grace_minutes: 10, half_day_under_hours: 4 }))
      .toEqual({ shiftStart: "09:30", shiftEnd: "18:30", lateGraceMinutes: 10, halfDayUnderHours: 4 });
  });
  it("ignores garbage rather than inventing a shift", () => {
    expect(parseShiftRules({ shift_start: "nope", shift_end: null, late_grace_minutes: -5, half_day_under_hours: 0 }))
      .toEqual(DEFAULT_SHIFT);
  });
});

describe("validateShiftInput", () => {
  it("accepts Pardeep's hours", () => {
    expect(validateShiftInput({ shiftStart: "10:00", shiftEnd: "18:00", lateGraceMinutes: 15, halfDayUnderHours: 4 }))
      .toEqual({ ok: true, rules: DEFAULT_SHIFT });
  });
  it("refuses an end before the start, with a sentence", () => {
    const r = validateShiftInput({ shiftStart: "18:00", shiftEnd: "10:00", lateGraceMinutes: 15, halfDayUnderHours: 4 });
    expect(r).toEqual({ ok: false, error: "Office end time must be after the start time." });
  });
  it("refuses a bad time, negative grace, zero half-day", () => {
    expect(validateShiftInput({ shiftStart: "10", shiftEnd: "18:00", lateGraceMinutes: 15, halfDayUnderHours: 4 }).ok).toBe(false);
    expect(validateShiftInput({ shiftStart: "10:00", shiftEnd: "18:00", lateGraceMinutes: -1, halfDayUnderHours: 4 }).ok).toBe(false);
    expect(validateShiftInput({ shiftStart: "10:00", shiftEnd: "18:00", lateGraceMinutes: 15, halfDayUnderHours: 0 }).ok).toBe(false);
  });
});

describe("formatGap", () => {
  it("minutes under an hour, hours from an hour up", () => {
    expect(formatGap(27)).toBe("27 min");
    expect(formatGap(60)).toBe("1h 00m");
    expect(formatGap(265)).toBe("4h 25m");
  });
});
