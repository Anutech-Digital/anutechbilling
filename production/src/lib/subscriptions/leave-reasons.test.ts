import { describe, it, expect } from "vitest";
import {
  LEAVE_REASONS, isLeaveReason, leaveReasonLabel, leaveReasonInputError, leaveReasonText, leaveReasonCounts, leftAt,
} from "./leave-reasons";

describe("R-2243 leave reasons", () => {
  it("has 8 short English reasons, Other last, unique codes", () => {
    expect(LEAVE_REASONS).toHaveLength(8);
    expect(new Set(LEAVE_REASONS.map((r) => r.code)).size).toBe(8);
    expect(LEAVE_REASONS[LEAVE_REASONS.length - 1].code).toBe("other");
    expect(LEAVE_REASONS.every((r) => r.label.length >= 5 && r.label.length <= 40)).toBe(true);
  });

  it("labels a code, and shows Not recorded for none / unknown", () => {
    expect(leaveReasonLabel("price")).toBe("Price too high");
    expect(leaveReasonLabel(null)).toBe("Not recorded");
    expect(leaveReasonLabel("nonsense")).toBe("Not recorded");
    expect(isLeaveReason("closed")).toBe(true);
    expect(isLeaveReason("")).toBe(false);
  });

  it("requires a reason; Other needs a note of 5+ characters; other reasons need none", () => {
    expect(leaveReasonInputError({ code: "", note: "" })).toMatch(/Pick why/);
    expect(leaveReasonInputError({ code: "bogus", note: "long enough note" })).toMatch(/Pick why/);
    expect(leaveReasonInputError({ code: "other", note: "  hi " })).toMatch(/Other/);
    expect(leaveReasonInputError({ code: "other", note: "Went abroad" })).toBeNull();
    expect(leaveReasonInputError({ code: "price", note: "" })).toBeNull();
  });

  it("builds the readable sentence kept in the old free-text column (always 5+ chars)", () => {
    expect(leaveReasonText("price", "")).toBe("Price too high");
    expect(leaveReasonText("price", "  found it cheaper ")).toBe("Price too high — found it cheaper");
    for (const r of LEAVE_REASONS) expect(leaveReasonText(r.code, "").length).toBeGreaterThanOrEqual(5);
  });

  const NOW = new Date("2026-11-17T10:00:00Z");
  it("dates a leaver by cancel day, or by the day Won't renew was set", () => {
    expect(leftAt({ status: "cancelled", cancelled_at: "2026-10-01T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(leftAt({ status: "active", auto_renew: false, non_renew_set_at: "2026-11-02T00:00:00Z" })).toBe("2026-11-02T00:00:00Z");
    expect(leftAt({ status: "active", auto_renew: true })).toBeNull();
    expect(leftAt({ status: "cancelled", cancelled_at: null })).toBeNull();   // cancelled before the date was kept
  });

  it("counts the last 12 months by reason, biggest first, Not recorded last", () => {
    const c = leaveReasonCounts([
      { status: "cancelled", cancelled_at: "2026-10-01T00:00:00Z", leave_reason_code: "price" },
      { status: "cancelled", cancelled_at: "2026-09-01T00:00:00Z", leave_reason_code: "price" },
      { status: "active", auto_renew: false, non_renew_set_at: "2026-11-02T00:00:00Z", leave_reason_code: "closed" },
      { status: "expired", auto_renew: false, non_renew_set_at: "2026-08-02T00:00:00Z", leave_reason_code: null },
      { status: "cancelled", cancelled_at: "2026-02-02T00:00:00Z", leave_reason_code: null },
      { status: "cancelled", cancelled_at: "2025-10-01T00:00:00Z", leave_reason_code: "price" },  // older than 12 months
      { status: "active", auto_renew: true },                                                       // not leaving
    ], NOW);
    expect(c.total).toBe(5);
    expect(c.rows.map((r) => [r.label, r.count, r.pct])).toEqual([
      ["Price too high", 2, 40], ["Business closed", 1, 20], ["Not recorded", 2, 40],
    ]);
  });

  it("is empty (total 0) when nobody left", () => {
    expect(leaveReasonCounts([], NOW)).toEqual({ total: 0, rows: [] });
  });
});
