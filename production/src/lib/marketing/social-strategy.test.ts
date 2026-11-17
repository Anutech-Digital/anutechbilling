import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANS, atIstHour, describePerformance, engagementScore, normalisePlan, pickTypes, summarisePerformance,
} from "./social-strategy";
import { toIstLocal } from "./social-schedule";

describe("R-2705 strategy plan", () => {
  it("keeps valid fields, drops bad ones, and makes the mix add up to 100", () => {
    const plan = normalisePlan({
      summary: "  Short tips  ", tone: "Warm", length: "short", hashtags: 40, bestHourIst: 3,
      mix: [{ type: "tip", share: 50 }, { type: "dance video", share: 30 }, { type: "question", share: 25 }, { type: "tip", share: 10 }],
    }, DEFAULT_PLANS.instagram);
    expect(plan.summary).toBe("Short tips");
    expect(plan.hashtags).toBe(15);
    expect(plan.bestHourIst).toBe(6);
    expect(plan.mix.map((m) => m.type)).toEqual(["tip", "question"]);
    expect(plan.mix.reduce((a, m) => a + m.share, 0)).toBe(100);
    expect(plan.audience).toBe(DEFAULT_PLANS.instagram.audience);
  });

  it("falls back to the default when the AI sends nothing usable", () => {
    expect(normalisePlan(null, DEFAULT_PLANS.linkedin)).toEqual(DEFAULT_PLANS.linkedin);
    expect(normalisePlan({ length: "huge", mix: "x" }, DEFAULT_PLANS.facebook).length).toBe("medium");
  });

  it("every default plan is already valid", () => {
    for (const p of Object.values(DEFAULT_PLANS)) expect(normalisePlan(p, p)).toEqual(p);
  });

  it("picks the kinds of post by share and spreads them out", () => {
    const mix = [{ type: "tip" as const, share: 40 }, { type: "question" as const, share: 30 }, { type: "checklist" as const, share: 30 }];
    expect(pickTypes(mix, 3)).toEqual(["tip", "question", "checklist"]);
    const ten = pickTypes(mix, 10);
    expect(ten.filter((t) => t === "tip")).toHaveLength(4);
    expect(ten[0]).not.toBe(ten[1]);
    expect(pickTypes(mix, 0)).toEqual([]);
  });

  it("moves a planned day to the platform's best hour (India time)", () => {
    const day = new Date("2026-11-13T03:30:00Z"); // 13 Nov 9:00 IST
    expect(toIstLocal(atIstHour(day, 19))).toBe("2026-11-13T19:00");
    expect(toIstLocal(atIstHour(day, 2))).toBe("2026-11-13T06:00");
  });
});

describe("R-2706 / R-2707 results and learning", () => {
  const s = (likes: number, comments = 0, shares = 0, saves = 0, reach: number | null = null) => ({ likes, comments, shares, saves, reach });
  it("counts comments, shares and saves more than likes", () => {
    expect(engagementScore(s(10, 2, 1, 1))).toBe(10 + 4 + 3 + 3);
    expect(engagementScore({ likes: null, comments: null, shares: null, saves: null, reach: null })).toBe(0);
  });

  it("ranks kinds of post and hours by score", () => {
    const p = summarisePerformance([
      { postType: "question", hourIst: 19, stats: s(10, 5, 0, 0, 400) },
      { postType: "question", hourIst: 19, stats: s(8, 3, 0, 0, 300) },
      { postType: "tip", hourIst: 9, stats: s(2, 0, 0, 0, 100) },
      { postType: null, hourIst: 9, stats: s(1) },
    ]);
    expect(p.posts).toBe(4);
    expect(p.byType[0]).toMatchObject({ type: "question", posts: 2, avgScore: 17, avgReach: 350 });
    expect(p.byType.find((t) => t.type === "other")?.avgReach).toBeNull();
    expect(p.byHour[0].hourIst).toBe(19);
    expect(describePerformance(p)).toContain("question: 2 posts, score 17, reach 350");
  });
});
