/**
 * R-2522 — the opening box's "lines where the running balance does not follow" counted lines
 * printed out of order INSIDE one day, while the preview's chain box (day-level) said "Balance
 * chain complete" — one screen, two answers. Staging HDFC FY 25-26: 7 such breaks, all on
 * 21 Nov 2025 (two FD redemptions printed out of order), day total right.
 */
import { describe, expect, it } from "vitest";
import { openingBalanceFromStatement } from "./opening-balance";

const L = (txn_date: string, debit: number, credit: number, balance_after: number | null) => ({ txn_date, debit, credit, balance_after });

describe("openingBalanceFromStatement — out of order inside a day (R-2522)", () => {
  it("two FD redemptions printed out of order: no chain break, an out-of-order note for that day", () => {
    const r = openingBalanceFromStatement([
      L("2025-11-20", 0, 1000, 2000),
      L("2025-11-21", 0, 700, 3000),   // printed first, happened second (2300 → 3000)
      L("2025-11-21", 0, 300, 2300),   // printed second, happened first (2000 → 2300)
      L("2025-11-22", 100, 0, 2900),
    ], "2025-11-20");
    expect(r).toMatchObject({ ok: true, chainBreaks: 0, outOfOrder: { days: ["2025-11-21"] } });
  });

  it("a line really missing is still a chain break, not an out-of-order note", () => {
    const r = openingBalanceFromStatement([
      L("2025-11-20", 0, 1000, 2000),
      L("2025-11-21", 0, 300, 2800),   // 500 came in with no line
    ], "2025-11-20");
    expect(r).toMatchObject({ ok: true, chainBreaks: 1 });
    expect(r.ok && r.outOfOrder).toBeFalsy();
  });
});
