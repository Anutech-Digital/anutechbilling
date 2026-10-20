import { describe, it, expect } from "vitest";
import { checkStatement, type StatementLine } from "./statement-check";

const L = (txn_date: string, debit: number, credit: number, balance_after: number | null): StatementLine =>
  ({ txn_date, debit, credit, balance_after });

describe("checkStatement", () => {
  it("agrees when opening and lines are complete", () => {
    const r = checkStatement([L("2026-04-02", 1000, 0, 99000), L("2026-04-05", 0, 500, 99500)], 100000);
    expect(r).toMatchObject({ statementBalance: 99500, appBalance: 99500, difference: 0, impliedOpening: 100000, openingDifference: 0, gaps: [] });
  });

  it("names an opening balance that was never set", () => {
    const r = checkStatement([L("2026-04-16", 19056, 0, 281245)], 0);
    expect(r).toMatchObject({ impliedOpening: 300301, openingDifference: -300301, difference: -300301, gaps: [] });
  });

  it("finds a missing debit between two dates", () => {
    // 2,00,000 left the bank between 8 and 17 Jul with no line for it.
    const r = checkStatement([
      L("2026-07-08", 0, 540000, 640000),
      L("2026-07-17", 2835, 0, 437165),
    ], 100000);
    expect(r?.gaps).toEqual([{ after: "2026-07-08", by: "2026-07-17", amount: 200000 }]);
    expect(r?.difference).toBe(200000);
  });

  it("does not read same-day lines stored out of order as a gap", () => {
    // Four salaries on one day, stored in a different order from the statement.
    // Statement order: −22,355 → 2,99,407, −35,000 → 2,64,407, −52,000 → 2,12,407, −35,000 → 1,77,407.
    const r = checkStatement([
      L("2026-09-01", 0, 1000, 321762),
      L("2026-09-03", 52000, 0, 212407),
      L("2026-09-03", 35000, 0, 177407),
      L("2026-09-03", 22355, 0, 299407),
      L("2026-09-03", 35000, 0, 264407),
    ], 320762);
    expect(r?.gaps).toEqual([]);
    expect(r?.statementBalance).toBe(177407);
    expect(r?.difference).toBe(0);
  });

  it("the gaps and the opening difference add up to the total difference", () => {
    const r = checkStatement([
      L("2026-04-16", 19056, 0, 281245),
      L("2026-07-17", 2835, 0, 78410),     // 2,00,000 missing before this
    ], 0);
    const explained = (r?.gaps ?? []).reduce((s, g) => s + g.amount, 0) + (r?.openingDifference ?? 0);
    expect(explained).toBe(r?.difference);
  });

  it("a hole inside a day that shows as −X then +Y is reported once, as its sum", () => {
    // 3 Sep: −2,000 lands on 96,000 (so 2,000 left before it, unimported) and −5,000 lands
    // on 85,000 (so 6,000 more left between them). Neither chains from 1,00,000, so the
    // day's end is ambiguous and the shortfall may split across 3 and 5 Sep.
    const r = checkStatement([
      L("2026-09-01", 0, 1000, 100000),
      L("2026-09-03", 5000, 0, 85000),
      L("2026-09-03", 2000, 0, 96000),
      L("2026-09-05", 1000, 0, 84000),
    ], 99000);
    const total = (r?.gaps ?? []).reduce((s, g) => s + g.amount, 0);
    expect(total).toBe(r!.difference - r!.openingDifference);
    expect((r?.gaps ?? []).every((g) => g.amount > 0)).toBe(true);
  });

  it("says nothing without the bank's running balance", () => {
    expect(checkStatement([L("2026-04-02", 1000, 0, null)], 0)).toBeNull();
    expect(checkStatement([], 0)).toBeNull();
  });

  it("lines without a balance still count — a filled gap stops being reported", () => {
    // The 2,00,000 RTGS was added later without a running balance (read from a PDF).
    const r = checkStatement([
      L("2026-07-08", 0, 540000, 640000),
      L("2026-07-16", 200000, 0, null),
      L("2026-07-17", 2835, 0, 437165),
    ], 100000);
    expect(r?.gaps).toEqual([]);
    expect(r?.difference).toBe(0);
  });

  it("still flags a wrong opening balance when some lines lack a balance", () => {
    // Before: one missing-balance line made the whole check return null, hiding this.
    const r = checkStatement([
      L("2026-04-16", 19056, 0, 281245),
      L("2026-05-02", 18999, 0, null),
      L("2026-05-12", 1000, 0, 261246),
    ], 0);
    expect(r).toMatchObject({ impliedOpening: 300301, openingDifference: -300301, gaps: [] });
  });

  it("R-1693: whole-rupee rounding of paise amounts never adds up to a false gap", () => {
    // Statements carry paise; lines are stored in whole rupees. ₹10.40 a line rounds to ₹10,
    // so over 60 days Σ(rounded) drifts ₹24 from the bank's own balance. Each line still
    // follows from the one before (±1) — that is not a missing line.
    const lines: StatementLine[] = [];
    let bal = 100000;
    for (let d = 1; d <= 60; d++) {
      bal -= 10.4;
      const date = new Date(Date.UTC(2026, 3, d)).toISOString().slice(0, 10);
      lines.push(L(date, 10, 0, Math.round(bal)));
    }
    const r = checkStatement(lines, 100000);
    expect(r?.gaps).toEqual([]);
  });
});
