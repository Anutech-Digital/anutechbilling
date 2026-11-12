/* R-2719 (12 Nov 2026) — the board's 60-min auto-free. 12 Nov: running cards were freed 3–4 times while
   their workers were busy, because the page read only liveLog OBJECTS with `at`; workers who wrote
   liveLog as plain strings (or only changed nowDoing) were timed from claimedAt. The rule now: quiet
   time counts from the NEWEST of claimedAt / any liveLog entry (object or string) / nowDoing update. */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { lastLifeMs, quietMin, shouldAutoFree, AUTO_FREE_MIN } from "../../scripts/ops/board-quiet.mjs";

const NOW = Date.parse("2026-11-12T15:00:00Z"); // 20:30 IST
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("board auto-free — sign of life (R-2719)", () => {
  it("12 Nov case: claimed 70 min ago, string liveLog line 5 min ago → NOT freed", () => {
    const card = { status: "doing", claimedAt: minsAgo(70), liveLog: [`${minsAgo(5)} w-x: tests green, next push`] };
    expect(quietMin(card, NOW)).toBe(5);
    expect(shouldAutoFree(card, NOW)).toBe(false);
  });

  it("liveLog object with `at` counts (as before)", () => {
    const card = { status: "doing", claimedAt: minsAgo(90), liveLog: [{ at: minsAgo(80), text: "a" }, { at: minsAgo(12), text: "b" }] };
    expect(quietMin(card, NOW)).toBe(12);
  });

  it("takes the newest entry, not the last one (an old string after a new object)", () => {
    const card = { status: "doing", claimedAt: minsAgo(90), liveLog: [{ at: minsAgo(7), text: "new" }, "no time in this line"] };
    expect(quietMin(card, NOW)).toBe(7);
  });

  it("a string line in board style '12 Nov 20:10 IST …' counts (IST → UTC, year from now)", () => {
    const card = { status: "doing", claimedAt: minsAgo(200), liveLog: ["12 Nov 20:10 IST coordinator: worker chal raha hai"] };
    expect(quietMin(card, NOW)).toBe(20);
  });

  it("'31 Dec 23:50 IST' read on 1 Jan belongs to last year, not 12 months ahead", () => {
    const jan = Date.parse("2027-01-01T00:00:00+05:30");
    expect(quietMin({ status: "doing", liveLog: ["31 Dec 23:50 IST x"] }, jan)).toBe(10);
  });

  it("nowDoing update: nowDoingAt (or the card's updatedAt) is a sign of life", () => {
    expect(quietMin({ status: "doing", claimedAt: minsAgo(70), nowDoing: "tsc", nowDoingAt: minsAgo(3) }, NOW)).toBe(3);
    expect(quietMin({ status: "doing", claimedAt: minsAgo(70), updatedAt: minsAgo(9) }, NOW)).toBe(9);
  });

  it("re-claimed card with an old liveLog counts from claimedAt (8 Nov rule kept)", () => {
    const card = { status: "doing", claimedAt: minsAgo(2), liveLog: [{ at: minsAgo(600), text: "old run" }] };
    expect(quietMin(card, NOW)).toBe(2);
  });

  it("a time in the future (typo / wrong clock) is ignored, so a card cannot stay claimed for ever", () => {
    const card = { status: "doing", claimedAt: minsAgo(75), liveLog: [{ at: "2027-11-12T15:00:00Z", text: "typo year" }] };
    expect(quietMin(card, NOW)).toBe(75);
    expect(shouldAutoFree(card, NOW)).toBe(true);
    // a few minutes ahead (another laptop's clock) is fine
    expect(quietMin({ status: "doing", claimedAt: minsAgo(75), nowDoingAt: new Date(NOW + 2 * 60_000).toISOString() }, NOW)).toBe(0);
  });

  it("frees at 60 min of real quiet; never a goal card; never a card that is not doing", () => {
    expect(AUTO_FREE_MIN).toBe(60);
    const quiet = { status: "doing", claimedAt: minsAgo(61), liveLog: [`${minsAgo(60)} last`] };
    expect(shouldAutoFree(quiet, NOW)).toBe(true);
    expect(shouldAutoFree({ ...quiet, liveLog: [`${minsAgo(59)} last`] }, NOW)).toBe(false);
    expect(shouldAutoFree({ ...quiet, kind: "goal" }, NOW)).toBe(false);
    expect(shouldAutoFree({ ...quiet, status: "review" }, NOW)).toBe(false);
  });

  it("no time anywhere → 0 quiet minutes (as the page did), bad values do not throw", () => {
    expect(quietMin({ status: "doing" }, NOW)).toBe(0);
    expect(quietMin({ status: "doing", claimedAt: "kal", liveLog: [null, 5, { at: "x" }, "32 Foo 99:99 IST"] }, NOW)).toBe(0);
    expect(lastLifeMs(null, NOW)).toBe(0);
  });

  it("lastLifeMs is self-contained — its source can be pasted into the board page as it is", () => {
    const pasted = new Function(`return (${lastLifeMs.toString()})`)() as (c: unknown, n: number) => number;
    const card = { claimedAt: minsAgo(70), liveLog: ["12 Nov 20:10 IST a", { at: minsAgo(4), text: "b" }], nowDoingAt: minsAgo(30) };
    expect(pasted(card, NOW)).toBe(lastLifeMs(card, NOW));
    expect(pasted(card, NOW)).toBe(NOW - 4 * 60_000);
  });
});
