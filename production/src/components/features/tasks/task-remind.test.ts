/**
 * R-2928 — the row's "Remind" button: when it shows, and the "Last reminded …" line.
 */
import { describe, expect, it } from "vitest";
import { canRemind, lastRemindedLabel } from "./task-remind";

describe("R-2928 canRemind — only on someone else's open task", () => {
  const t = { status: "pending", owner_id: "u-hitesh" };
  it("a teammate's open task: yes", () => {
    expect(canRemind(t, "u-me")).toBe(true);
    expect(canRemind({ ...t, status: "snoozed" }, "u-me")).toBe(true);
  });
  it("my own task, no owner, done, or 'me' not known yet: no", () => {
    expect(canRemind({ ...t, owner_id: "u-me" }, "u-me")).toBe(false);
    expect(canRemind({ ...t, owner_id: null }, "u-me")).toBe(false);
    expect(canRemind({ ...t, status: "done" }, "u-me")).toBe(false);
    expect(canRemind({ ...t, status: "cancelled" }, "u-me")).toBe(false);
    expect(canRemind(t, null)).toBe(false);
    expect(canRemind(t, undefined)).toBe(false);
  });
});

describe("R-2928 lastRemindedLabel — IST, whatever the browser's zone", () => {
  it("date and time of the last reminder", () => {
    expect(lastRemindedLabel("2026-11-18T10:40:00Z")).toBe("Last reminded 18 Nov, 4:10 pm");
    expect(lastRemindedLabel("2026-11-18T19:00:00Z")).toBe("Last reminded 19 Nov, 12:30 am");
  });
  it("nothing when never reminded or the value is not a date", () => {
    expect(lastRemindedLabel(null)).toBeNull();
    expect(lastRemindedLabel(undefined)).toBeNull();
    expect(lastRemindedLabel("not a date")).toBeNull();
  });
});
