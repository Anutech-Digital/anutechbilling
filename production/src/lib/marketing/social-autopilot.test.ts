import { describe, expect, it } from "vitest";
import { parsePictureLinks, pictureFor, planSlots, planStatus } from "./social-autopilot";
import { toIstLocal } from "./social-schedule";

describe("R-2672 AI autopilot — the week it plans", () => {
  // Monday 9 Nov 2026, 9:00 IST (03:30 UTC) — the cron's Monday run.
  const monday = new Date("2026-11-09T03:30:00Z");

  it("3 posts a week → Tue 9 AM, Thu 6 PM, Sat 9 AM (India time)", () => {
    expect(planSlots(monday, 3).map((d) => toIstLocal(d))).toEqual(["2026-11-10T09:00", "2026-11-12T18:00", "2026-11-14T09:00"]);
  });

  it("every slot is after now and within the next 7 days; counts are clamped to 1–7", () => {
    for (const n of [1, 2, 5, 7]) {
      const slots = planSlots(monday, n);
      expect(slots).toHaveLength(n);
      for (const s of slots) { expect(s.getTime()).toBeGreaterThan(monday.getTime()); expect(s.getTime() - monday.getTime()).toBeLessThanOrEqual(8 * 86_400_000); }
    }
    expect(planSlots(monday, 0)).toHaveLength(1);
    expect(planSlots(monday, 20)).toHaveLength(7);
  });

  it("late at night UTC still plans from India's tomorrow", () => {
    // 9 Nov 20:00 UTC = 10 Nov 01:30 IST → first post 11 Nov.
    expect(toIstLocal(planSlots(new Date("2026-11-09T20:00:00Z"), 1)[0])).toBe("2026-11-11T09:00");
  });

  it("autopilot posts are approved (go out at their time); otherwise they wait for approval", () => {
    expect(planStatus(true)).toBe("approved");
    expect(planStatus(false)).toBe("review");
  });

  it("pictures are used in turn; none → null", () => {
    expect([0, 1, 2].map((i) => pictureFor(["https://a/1.jpg", "https://a/2.jpg"], i))).toEqual(["https://a/1.jpg", "https://a/2.jpg", "https://a/1.jpg"]);
    expect(pictureFor([], 0)).toBeNull();
  });

  it("picture links: https only, one per line, no repeats", () => {
    expect(parsePictureLinks("https://x.com/a.jpg\n\nhttp://x.com/b.jpg\nhttps://x.com/a.jpg\nnot a link")).toEqual({ urls: ["https://x.com/a.jpg"], bad: ["http://x.com/b.jpg", "not a link"] });
  });
});
