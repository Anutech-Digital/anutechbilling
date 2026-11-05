import { describe, expect, it } from "vitest";
import { formatIst, isDue, parseIstLocal, scheduleProblem, toIstLocal } from "./social-schedule";

describe("R-2510 social post time (IST)", () => {
  it("reads the typed time as India time, whatever the browser zone", () => {
    expect(parseIstLocal("2026-11-06T09:00")?.toISOString()).toBe("2026-11-06T03:30:00.000Z");
    expect(parseIstLocal("2026-11-06T02:00")?.toISOString()).toBe("2026-11-05T20:30:00.000Z");
  });

  it("refuses text that is not a real date and time", () => {
    for (const bad of ["", "2026-02-30T09:00", "2026-11-06 09:00", "2026-11-06T25:00", "tomorrow"]) expect(parseIstLocal(bad)).toBeNull();
  });

  it("puts a saved time back into the form unchanged", () => {
    expect(toIstLocal("2026-11-06T03:30:00.000Z")).toBe("2026-11-06T09:00");
    expect(toIstLocal(parseIstLocal("2026-12-31T23:45")!)).toBe("2026-12-31T23:45");
  });

  it("shows the time in IST", () => {
    expect(formatIst("2026-11-06T03:30:00.000Z")).toMatch(/6 Nov 2026.*9:00/);
  });

  it("a post time must be in the future and within a year", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    expect(scheduleProblem(new Date("2026-11-05T09:59:00Z"), now)).toMatch(/future/);
    expect(scheduleProblem(new Date("2028-01-01T00:00:00Z"), now)).toMatch(/year/);
    expect(scheduleProblem(new Date("2026-11-06T03:30:00Z"), now)).toBeNull();
  });

  it("only an approved post whose time has come is due — never a draft or one in review", () => {
    const now = new Date("2026-11-06T04:00:00Z");
    const at = "2026-11-06T03:30:00Z";
    expect(isDue({ status: "approved", scheduled_at: at }, now)).toBe(true);
    expect(isDue({ status: "approved", scheduled_at: "2026-11-06T05:00:00Z" }, now)).toBe(false);
    expect(isDue({ status: "approved", scheduled_at: null }, now)).toBe(false);
    for (const status of ["draft", "review", "publishing", "published", "failed"]) expect(isDue({ status, scheduled_at: at }, now)).toBe(false);
  });
});
