import { describe, expect, it } from "vitest";
import { linkedInDailyFrom, linkedInHistoryChunks, linkedInOldestDay } from "./linkedin-history";

describe("LinkedIn history windows", () => {
  const today = "2026-11-02";

  it("uses complete older months and daily recent dates without overlap", () => {
    expect(linkedInDailyFrom(today)).toBe("2026-06-01");
    expect(linkedInHistoryChunks("2026-05-20", "2026-06-20", today)).toEqual([
      { from: "2026-05-01", to: "2026-05-31", granularity: "MONTHLY" },
      { from: "2026-06-01", to: "2026-06-20", granularity: "DAILY" },
    ]);
  });

  it("splits all available history into calendar years and short daily requests", () => {
    expect(linkedInOldestDay(today)).toBe("2016-12-01");
    const chunks = linkedInHistoryChunks(linkedInOldestDay(today), today, today);
    expect(chunks[0]).toEqual({ from: "2016-12-01", to: "2016-12-31", granularity: "MONTHLY" });
    expect(chunks.at(-1)).toEqual({ from: "2026-08-30", to: "2026-11-02", granularity: "DAILY" });
    expect(chunks.every((c, i) => i === 0 || c.from > chunks[i - 1].to)).toBe(true);
  });

  it("rejects invalid or unsupported dates", () => {
    expect(() => linkedInHistoryChunks("2026-02-30", today, today)).toThrow();
    expect(() => linkedInHistoryChunks("2016-11-01", today, today)).toThrow();
    expect(() => linkedInHistoryChunks(today, "2026-11-03", today)).toThrow();
  });
});
