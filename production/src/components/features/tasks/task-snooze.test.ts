import { describe, it, expect } from "vitest";
import { snoozeChoices, snoozedMessage } from "./task-snooze";

// Fri 9 Oct 2026, 12:15 IST = 06:45 UTC
const FRI_NOON = new Date("2026-10-09T06:45:00Z");

describe("snoozeChoices (R-471)", () => {
  it("Friday noon: 1 hour, this evening, tomorrow 10 AM, Monday 10 AM — all from now, in IST", () => {
    const c = snoozeChoices(FRI_NOON);
    expect(c.map((x) => x.key)).toEqual(["1h", "evening", "tomorrow", "monday"]);
    expect(c[0].at.toISOString()).toBe("2026-10-09T07:45:00.000Z");
    expect(c[1].at.toISOString()).toBe("2026-10-09T12:30:00.000Z"); // 6 PM IST
    expect(c[2].at.toISOString()).toBe("2026-10-10T04:30:00.000Z"); // Sat 10 AM IST
    expect(c[3].at.toISOString()).toBe("2026-10-12T04:30:00.000Z"); // Mon 10 AM IST
  });
  it("no 'this evening' after 5 PM", () => {
    const c = snoozeChoices(new Date("2026-10-09T12:00:00Z")); // 5:30 PM IST
    expect(c.map((x) => x.key)).not.toContain("evening");
  });
  it("late at night the IST date is used (23:30 IST Fri → tomorrow = Sat)", () => {
    const c = snoozeChoices(new Date("2026-10-09T18:00:00Z"));
    expect(c.find((x) => x.key === "tomorrow")!.at.toISOString()).toBe("2026-10-10T04:30:00.000Z");
  });
  it("on Sunday 'Monday' is skipped — it is tomorrow", () => {
    const c = snoozeChoices(new Date("2026-10-11T06:00:00Z"));
    expect(c.map((x) => x.key)).toEqual(["1h", "evening", "tomorrow"]);
  });
  it("on Monday it means next Monday", () => {
    const c = snoozeChoices(new Date("2026-10-12T06:00:00Z"));
    expect(c.find((x) => x.key === "monday")!.at.toISOString()).toBe("2026-10-19T04:30:00.000Z");
  });
});

describe("snoozedMessage", () => {
  it("uses the app's date format, not 10/10/2026, 3:00:00 pm", () => {
    expect(snoozedMessage("2026-10-10T09:30:00Z")).toBe("Snoozed to 10 Oct 2026, 03:00 pm");
  });
});
