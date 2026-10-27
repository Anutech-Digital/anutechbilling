import { describe, it, expect } from "vitest";
import { isRealDate, fixStatementDates } from "./statement-dates";

describe("isRealDate", () => {
  it.each([["2026-08-21", true], ["2026-21-08", false], ["2026-02-30", false], ["2028-02-29", true], ["2026-02-29", false], ["21/08/2026", false]])(
    "%s → %s", (d, ok) => expect(isRealDate(d)).toBe(ok),
  );
});

describe("fixStatementDates", () => {
  it("leaves a correct statement alone", () => {
    expect(fixStatementDates(["2026-04-02", "2026-08-21"])).toEqual({ dates: ["2026-04-02", "2026-08-21"], swapped: 0, swappedAll: false, future: 0 });
  });

  it("fixes the real case: one impossible date among correct ones", () => {
    // Most rows fine, one came back day-first.
    const r = fixStatementDates(["2026-08-07", "2026-08-09", "2026-21-08", "2026-09-03"]);
    expect(r.dates).toEqual(["2026-08-07", "2026-08-09", "2026-08-21", "2026-09-03"]);
    expect(r).toMatchObject({ swapped: 1, swappedAll: false });
  });

  it("a statement read day-first throughout is flipped together, hidden swaps included", () => {
    // Meant: 2 Apr, 16 Apr, 21 Aug. Read as YYYY-DD-MM. "2026-02-04" alone would pass as 4 Feb.
    const r = fixStatementDates(["2026-02-04", "2026-16-04", "2026-21-08"]);
    expect(r.dates).toEqual(["2026-04-02", "2026-04-16", "2026-08-21"]);
    expect(r.swappedAll).toBe(true);
  });

  it("R-1890: a date after today is NEVER swapped — kept as it is and counted for a warning", () => {
    // Before R-1890, 8 Oct / 8 Nov were taken as misreads of 10 / 11 Aug and flipped.
    const r = fixStatementDates(["2026-08-09", "2026-10-08", "2026-11-08", "2026-09-03"], "2026-09-25");
    expect(r.dates).toEqual(["2026-08-09", "2026-10-08", "2026-11-08", "2026-09-03"]);
    expect(r).toMatchObject({ swapped: 0, swappedAll: false, future: 2 });
  });

  it("R-1890: ISO 2026-11-05 stays 5 Nov (it was turned into 11 May)", () => {
    const r = fixStatementDates(["2026-10-20", "2026-11-05"], "2026-10-26");
    expect(r.dates).toEqual(["2026-10-20", "2026-11-05"]);
    expect(r).toMatchObject({ swapped: 0, future: 1 });
  });

  it("R-1890: real dates are never flipped just because flipped they look more in order", () => {
    // All real as given. Flipped (1 Feb, 3 Jan, 2 Jan) they would run neatly backwards — no evidence of a misread.
    const r = fixStatementDates(["2026-01-02", "2026-03-01", "2026-02-01"]);
    expect(r.dates).toEqual(["2026-01-02", "2026-03-01", "2026-02-01"]);
    expect(r).toMatchObject({ swapped: 0, swappedAll: false });
  });

  it("future is 0 when nothing is after today", () => {
    expect(fixStatementDates(["2026-08-07"], "2026-09-25").future).toBe(0);
  });

  it("without `today`, a future date is left as it is", () => {
    expect(fixStatementDates(["2026-11-08"]).dates).toEqual(["2026-11-08"]);
  });

  it("returns null for a date that is impossible either way", () => {
    expect(fixStatementDates(["2026-08-07", "2026-31-31"]).dates).toEqual(["2026-08-07", null]);
  });
});
