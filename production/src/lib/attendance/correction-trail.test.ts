import { describe, expect, it } from "vitest";
import { describeCorrection, sortTrail, type CorrectionRow } from "./correction-trail";

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const D = "2026-10-08";
const base: CorrectionRow = {
  id: "a", changed_at: "2026-10-10T10:00:00Z", changed_by: "u1", reason: "Kiosk recorded 11:00 by mistake",
  old_status: "present", new_status: "present",
  old_check_in: ist(D, "10:20"), old_check_out: ist(D, "11:00"),
  new_check_in: ist(D, "10:20"), new_check_out: ist(D, "19:00"),
};

describe("R-439 describeCorrection — the day's history in the Fix dialog", () => {
  it("a wrong check-out fixed: only the check-out line, in IST", () => {
    expect(describeCorrection(base)).toEqual([{ field: "Check-out", before: "11:00", after: "19:00" }]);
  });
  it("missing day added: Absent → Present plus both times", () => {
    expect(describeCorrection({ ...base, old_status: "absent", old_check_in: null, old_check_out: null })).toEqual([
      { field: "Status", before: "Absent", after: "Present" },
      { field: "Check-in", before: "—", after: "10:20" },
      { field: "Check-out", before: "—", after: "19:00" },
    ]);
  });
  it("marked absent: just the status (the times went with it)", () => {
    expect(describeCorrection({ ...base, new_status: "absent", new_check_in: null, new_check_out: null })).toEqual([
      { field: "Status", before: "Present", after: "Absent" },
    ]);
  });
  it("an unchanged re-save lists nothing", () => {
    expect(describeCorrection({ ...base, new_check_out: base.old_check_out })).toEqual([]);
  });
});

describe("sortTrail", () => {
  it("newest first, stable on ties", () => {
    const rows = [
      { id: "a", changed_at: "2026-10-10T10:00:00Z" },
      { id: "c", changed_at: "2026-10-10T12:00:00Z" },
      { id: "b", changed_at: "2026-10-10T10:00:00Z" },
    ];
    expect(sortTrail(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});
