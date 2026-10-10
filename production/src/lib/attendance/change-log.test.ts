import { describe, expect, it } from "vitest";
import { describeAttendanceChange } from "./change-log";

describe("describeAttendanceChange (R-608)", () => {
  it("update: shows check-out before → after in IST, skips housekeeping columns", () => {
    const lines = describeAttendanceChange("update", {
      check_out: { old: null, new: "2026-10-01T13:30:00+00:00" },
      updated_by: { old: "a", new: "b" },
      selfie_out: { old: null, new: "x.jpg" },
    });
    expect(lines).toEqual([{ field: "Check-out", before: "—", after: "19:00" }]);
  });

  it("insert: a day added by hand", () => {
    const lines = describeAttendanceChange("insert", {
      new: { check_in: "2026-10-03T04:30:00+00:00", check_out: "2026-10-03T12:30:00+00:00", source: "manual" },
    });
    expect(lines).toEqual([
      { field: "Check-in", before: "—", after: "10:00" },
      { field: "Check-out", before: "—", after: "18:00" },
      { field: "Source", before: "—", after: "manual" },
    ]);
  });

  it("insert via Fix attendance also shows the owner's note", () => {
    const lines = describeAttendanceChange("insert", {
      new: { check_in: null, check_out: null, source: "manual", correction_note: " Forgot to check in " },
    });
    expect(lines.at(-1)).toEqual({ field: "Note", before: "—", after: "Forgot to check in" });
  });

  it("delete: a day removed", () => {
    const lines = describeAttendanceChange("delete", { old: { check_in: "2026-10-03T04:30:00+00:00", check_out: null, source: "self" } });
    expect(lines[0]).toEqual({ field: "Check-in", before: "10:00", after: "—" });
    expect(lines[1]).toEqual({ field: "Check-out", before: "—", after: "—" });
  });

  it("flags cleared and marked reviewed read as words", () => {
    const lines = describeAttendanceChange("update", {
      flags: { old: ["no_location", "new_device"], new: [] },
      reviewed_at: { old: null, new: "2026-10-10T03:00:00Z" },
    });
    expect(lines).toEqual([
      { field: "Flags", before: "no_location, new_device", after: "—" },
      { field: "Reviewed", before: "—", after: "yes" },
    ]);
  });

  it("garbage in → nothing, never a crash", () => {
    expect(describeAttendanceChange("update", null)).toEqual([]);
    expect(describeAttendanceChange("insert", { new: "oops" })).toEqual([]);
  });
});
