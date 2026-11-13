import { describe, expect, it } from "vitest";
import {
  FALLBACK_TODO, aiMaySend, cleanReply, followerTrend, normaliseKind, normaliseTodo, tickTodo, weekStart, type FollowerRow,
} from "./social-engagement";

describe("R-2690 followers", () => {
  const rows: FollowerRow[] = [
    { platform: "facebook", day: "2026-10-10", followers: 80 },
    { platform: "facebook", day: "2026-11-05", followers: 100 },
    { platform: "facebook", day: "2026-11-06", followers: 104 },
    { platform: "facebook", day: "2026-11-13", followers: 120 },
    { platform: "instagram", day: "2026-11-13", followers: 7 },
  ];
  it("gives today's count, the change over 7 and 30 days and the last 30 days", () => {
    const t = followerTrend(rows, "facebook", "2026-11-13");
    expect(t.now).toBe(120);
    expect(t.change7).toBe(16); // vs 6 Nov (the latest on or before 7 days ago)
    expect(t.change30).toBe(40); // vs 10 Oct
    expect(t.series.map((s) => s.day)).toEqual(["2026-11-05", "2026-11-06", "2026-11-13"]);
  });
  it("no older snapshot → no change shown (never a made-up 0)", () => {
    expect(followerTrend(rows, "instagram", "2026-11-13")).toMatchObject({ now: 7, change7: null, change30: null });
    expect(followerTrend(rows, "linkedin", "2026-11-13").now).toBeNull();
  });
  it("a report week starts on Monday", () => {
    expect(weekStart("2026-11-13")).toBe("2026-11-09"); // Friday → Monday
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday
  });
});

describe("R-2689 comment replies", () => {
  it("the AI sends by itself only on Autopilot, never for complaints or spam, never while stopped", () => {
    expect(aiMaySend("auto", "question", false)).toBe(true);
    expect(aiMaySend("auto", "praise", false)).toBe(true);
    expect(aiMaySend("auto", "complaint", false)).toBe(false);
    expect(aiMaySend("auto", "spam", false)).toBe(false);
    expect(aiMaySend("ask", "question", false)).toBe(false);
    expect(aiMaySend("auto", "question", true)).toBe(false);
  });
  it("cleans the reply and reads unknown kinds as other", () => {
    expect(cleanReply("  Thanks!   See https://evil.example/x  ")).toBe("Thanks! See");
    expect(cleanReply("x".repeat(900))).toHaveLength(800);
    expect(normaliseKind("Complaint")).toBe("complaint");
    expect(normaliseKind("rant")).toBe("other");
  });
});

describe("R-2691 daily to-do", () => {
  it("keeps the AI's items, fills up to 5 from the fallback list, gives each an id", () => {
    const items = normaliseTodo([{ text: "Reply to the 2 Instagram DMs", why: "Fast answers win" }, { text: "" }, "junk"], "2026-11-13");
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({ id: "2026-11-13-1", text: "Reply to the 2 Instagram DMs", why: "Fast answers win", done: false });
    expect(items[1].text).toBe(FALLBACK_TODO[0].text);
    expect(normaliseTodo(null, "d")).toHaveLength(5);
  });
  it("ticks only the item asked", () => {
    const items = normaliseTodo([], "d");
    const next = tickTodo(items, "d-2", true, "Abhishek", "2026-11-13T09:00:00Z");
    expect(next[1]).toMatchObject({ done: true, doneBy: "Abhishek" });
    expect(next.filter((t) => t.done)).toHaveLength(1);
    expect(tickTodo(next, "d-2", false, "x", "y")[1]).toMatchObject({ done: false, doneBy: null });
  });
});
