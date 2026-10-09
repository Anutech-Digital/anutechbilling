import { describe, it, expect } from "vitest";
import { snoozeByMinutes, snoozedMessage } from "./snooze";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fri 9 Oct 2026, 12:15 IST = 06:45 UTC
const NOW = new Date("2026-10-09T06:45:00Z");

describe("snoozeByMinutes (R-490 — lead sheet / deal page snooze)", () => {
  it("an overdue task lands a day from NOW, not a day from its old due time", () => {
    const threeDaysAgo = "2026-10-06T04:30:00Z";
    const at = snoozeByMinutes(threeDaysAgo, 24 * 60, NOW);
    expect(at.toISOString()).toBe("2026-10-10T06:45:00.000Z");
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });
  it("a future task moves by exactly the snooze", () => {
    const at = snoozeByMinutes("2026-10-10T04:30:00Z", 24 * 60, NOW);
    expect(at.toISOString()).toBe("2026-10-11T04:30:00.000Z");
  });
  it("no due time counts from now", () => {
    expect(snoozeByMinutes(null, 60, NOW).toISOString()).toBe("2026-10-09T07:45:00.000Z");
  });
});

describe("one toast format everywhere", () => {
  it("reads like the rest of the app, in IST", () => {
    expect(snoozedMessage("2026-10-10T04:30:00Z")).toBe("Snoozed to 10 Oct 2026, 10:00 am");
  });
  it("useSnoozeTask no longer uses toLocaleString or the old due time", () => {
    const src = readFileSync(join(__dirname, "../queries/tasks.ts"), "utf8");
    const body = src.slice(src.indexOf("export function useSnoozeTask"), src.indexOf("export function useDeleteTask"));
    expect(body).toContain("snoozeByMinutes(");
    expect(body).toContain("snoozedMessage(");
    expect(body).not.toContain("toLocaleString");
  });
});
