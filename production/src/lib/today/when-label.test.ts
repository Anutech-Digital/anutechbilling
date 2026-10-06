/**
 * R-241 (6 Oct 2026): /today compared due_at with "now" in milliseconds. A GSTR due today
 * (IST midnight) read "late" the whole day, and with Math.round something due tomorrow at
 * 15:00 read "due today" from 03:00 onwards. The label is now an IST calendar-day compare.
 */
import { describe, it, expect } from "vitest";
import { todayWhenLabel, type TodayItem } from "./inbox";

const item = (p: Partial<TodayItem>): TodayItem => ({
  kind: "task", id: "x", title: "t", due_at: null, priority: 50, href: "/tasks", ...p,
});

/* 6 Oct 2026, 10:00 IST = 04:30 UTC. */
const NOW = Date.parse("2026-10-06T04:30:00Z");

describe("todayWhenLabel — IST calendar days, not milliseconds", () => {
  it("due today at 15:00 IST → due today", () => {
    expect(todayWhenLabel(item({ due_at: "2026-10-06T09:30:00Z" }), NOW)).toBe("due today");
  });

  it("due today at IST midnight (a filing) is due today all day, not late", () => {
    const due = "2026-10-05T18:30:00.000Z"; // 6 Oct 00:00 IST
    expect(todayWhenLabel(item({ kind: "compliance", due_at: due }), NOW)).toBe("due today");
    expect(todayWhenLabel(item({ kind: "compliance", due_at: due }), Date.parse("2026-10-06T18:00:00Z"))).toBe("due today"); // 23:30 IST
  });

  it("due earlier today (already past the hour) is still due today", () => {
    expect(todayWhenLabel(item({ due_at: "2026-10-06T03:30:00Z" }), NOW)).toBe("due today"); // 09:00 IST
  });

  it("tomorrow 15:00 IST → in 1d, even late at night", () => {
    const due = "2026-10-07T09:30:00Z";
    expect(todayWhenLabel(item({ due_at: due }), NOW)).toBe("in 1d");
    expect(todayWhenLabel(item({ due_at: due }), Date.parse("2026-10-06T18:00:00Z"))).toBe("in 1d"); // 23:30 IST
  });

  it("yesterday (any hour) → 1d late", () => {
    expect(todayWhenLabel(item({ due_at: "2026-10-05T12:00:00Z" }), NOW)).toBe("1d late"); // 5 Oct 17:30 IST
    expect(todayWhenLabel(item({ due_at: "2026-10-04T18:30:00Z" }), NOW)).toBe("1d late"); // 5 Oct 00:00 IST
  });

  it("the IST day boundary decides, not UTC: 00:15 IST today is today", () => {
    // 6 Oct 00:15 IST = 5 Oct 18:45 UTC — UTC calls it yesterday.
    expect(todayWhenLabel(item({ due_at: "2026-10-05T18:45:00Z" }), NOW)).toBe("due today");
  });

  it("further ahead and further behind count calendar days", () => {
    expect(todayWhenLabel(item({ due_at: "2026-10-09T18:29:00Z" }), NOW)).toBe("in 3d"); // 9 Oct 23:59 IST
    expect(todayWhenLabel(item({ due_at: "2026-10-01T05:00:00Z" }), NOW)).toBe("5d late");
  });

  it("no deadline or a bad date → no label; arrival kinds are not deadlines", () => {
    expect(todayWhenLabel(item({ due_at: null }), NOW)).toBe("");
    expect(todayWhenLabel(item({ due_at: "nope" }), NOW)).toBe("");
    expect(todayWhenLabel(item({ kind: "enquiry", due_at: "2026-10-05T12:00:00Z" }), NOW)).toBeNull();
  });
});
