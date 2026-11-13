/* R-2652 — Zoho's limit said plainly: the streak, the try-again time (IST) and the read loop.
   Zoho is never called: `step` is a fake, sleep resolves at once, the clock is fixed. */
import { describe, it, expect } from "vitest";
import {
  busyStreak, nextIstMidnight, readUntilDone, zohoBusyText, zohoDayLimitMessage, zohoLimitHit, zohoLimitText,
  ZOHO_BUSY_RETRY_MS, ZOHO_LIMIT_STREAK,
} from "./zoho-limit";

/* 10 Nov 2026 10:30 IST = 05:00 UTC */
const NOW = Date.UTC(2026, 10, 10, 5, 0, 0);

describe("R-2652 try-again time", () => {
  it("is the next midnight IST (11 Nov 00:00 IST = 10 Nov 18:30 UTC)", () => {
    expect(new Date(nextIstMidnight(NOW)).toISOString()).toBe("2026-11-10T18:30:00.000Z");
    expect(zohoLimitHit(NOW).retryLabel).toBe("12:00 am IST on 11 Nov 2026");
  });
  it("late at night IST (23:50 on 10 Nov) still means 11 Nov, after 00:00 IST it is the day after", () => {
    expect(zohoLimitHit(Date.UTC(2026, 10, 10, 18, 20)).retryLabel).toBe("12:00 am IST on 11 Nov 2026");
    expect(zohoLimitHit(Date.UTC(2026, 10, 10, 18, 40)).retryLabel).toBe("12:00 am IST on 12 Nov 2026");
  });
  it("the message says the limit, the time and that nothing was changed", () => {
    const t = zohoLimitText(zohoLimitHit(NOW));
    expect(t.title).toBe("Zoho's daily limit is reached");
    expect(t.body).toContain("Try again after 12:00 am IST on 11 Nov 2026");
    expect(t.body).toContain("Nothing was changed");
    expect(zohoBusyText(2)).toBe(`Zoho is busy — trying again in a minute (2 of ${ZOHO_LIMIT_STREAK}).`);
  });
});

describe("R-2652 busy streak", () => {
  it(`hits only at ${ZOHO_LIMIT_STREAK} busy answers in a row; a good answer starts again`, () => {
    const s = busyStreak();
    expect(s.note(true, NOW)).toBeNull();
    expect(s.note(true, NOW)).toBeNull();
    expect(s.note(false, NOW)).toBeNull();
    expect(s.count).toBe(0);
    expect(s.note(true, NOW)).toBeNull();
    expect(s.note(true, NOW)).toBeNull();
    expect(s.note(true, NOW)?.retryLabel).toBe("12:00 am IST on 11 Nov 2026");
  });
});

describe("R-2652 read loop", () => {
  const run = (answers: Array<{ complete: boolean; busy?: boolean }>) => {
    const slept: number[] = [];
    const busy: number[] = [];
    let i = 0;
    const p = readUntilDone({
      step: async () => answers[Math.min(i++, answers.length - 1)],
      onBusy: (n) => busy.push(n),
      gapMs: 3_000, sleep: async (ms) => { slept.push(ms); }, now: () => NOW,
    });
    return { p, slept, busy, calls: () => i };
  };

  it("Zoho refusing every read: stops after 3 tries (no endless retry) with the limit hit", async () => {
    const r = run([{ complete: false, busy: true }]);
    const end = await r.p;
    expect(end.end).toBe("limit");
    expect(end.end === "limit" && end.hit.retryLabel).toBe("12:00 am IST on 11 Nov 2026");
    expect(r.calls()).toBe(ZOHO_LIMIT_STREAK);
    expect(r.slept).toEqual([ZOHO_BUSY_RETRY_MS, ZOHO_BUSY_RETRY_MS]);
    expect(r.busy).toEqual([1, 2, 3]);
  });

  it("busy once, then good answers: carries on to the end (one minute's wait, then the normal gap)", async () => {
    const r = run([{ complete: false, busy: true }, { complete: false }, { complete: true }]);
    expect((await r.p).end).toBe("complete");
    expect(r.slept).toEqual([ZOHO_BUSY_RETRY_MS, 3_000]);
    expect(r.busy).toEqual([1, 0, 0]);
  });

  it("busy, busy, good, busy, busy: never reaches 3 in a row → no stop", async () => {
    const b = { complete: false, busy: true };
    const r = run([b, b, { complete: false }, b, b, { complete: true }]);
    expect((await r.p).end).toBe("complete");
  });

  it("review: busy part-way while reading moves on (another reader shares Zoho's minute) is NOT the daily limit", async () => {
    const r = run([
      { complete: false, busy: true, listed: 200, detailed: 10 } as { complete: boolean; busy?: boolean },
      { complete: false, busy: true, listed: 200, detailed: 25 } as { complete: boolean; busy?: boolean },
      { complete: false, busy: true, listed: 200, detailed: 40 } as { complete: boolean; busy?: boolean },
      { complete: false, busy: true, listed: 200, detailed: 55 } as { complete: boolean; busy?: boolean },
      { complete: true, listed: 200, detailed: 200 } as { complete: boolean; busy?: boolean },
    ]);
    expect((await r.p).end).toBe("complete");
  });

  it("R-2661: a dayLimit answer (the app's own day budget is used) ends at once — no 3 tries, no wait — with the budget words", async () => {
    const r = run([{ complete: false, busy: true, dayLimit: { calls: 900, budget: 900, retryAt: nextIstMidnight(NOW) } } as never]);
    const end = await r.p;
    expect(end.end).toBe("limit");
    if (end.end !== "limit") throw new Error("no hit");
    expect(end.hit).toMatchObject({ reason: "budget", calls: 900, budget: 900, retryLabel: "12:00 am IST on 11 Nov 2026" });
    expect(r.calls()).toBe(1);
    expect(r.slept).toEqual([]);
    expect(r.busy).toEqual([0]);
    const t = zohoLimitText(end.hit);
    expect(t.title).toBe("Zoho's daily limit is reached");
    expect(t.body).toContain("Zoho calls today: 900 of 900");
    expect(t.body).toContain("carries on after 12:00 am IST on 11 Nov 2026");
    expect(t.body).toContain("Nothing was changed");
    expect(t.body).not.toContain("refused 3 reads");
    /* The server's own line (bg_error) is the same words. */
    expect(zohoDayLimitMessage({ calls: 900, budget: 900, retryAt: nextIstMidnight(NOW) }, NOW)).toBe(t.body);
    /* A dayLimit without a usable retryAt falls back to the next midnight IST. */
    expect(zohoLimitHit(NOW, { calls: 1, budget: 2, retryAt: NaN }).retryLabel).toBe("12:00 am IST on 11 Nov 2026");
  });

  it("closing the dialog stops the loop", async () => {
    let stop = false;
    const end = await readUntilDone({
      step: async () => { stop = true; return { complete: false, busy: true }; },
      shouldStop: () => stop, gapMs: 1, sleep: async () => {}, now: () => NOW,
    });
    expect(end.end).toBe("stopped");
  });
});
