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

describe("checkStatement — paise rounding vs real gaps (R-1829)", () => {
  /* Seeded so the test is the same every run. */
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  /** Real-looking statement: random paise amounts, a few lines a day, stored rounded. */
  function randomStatement(seed: number, n: number): StatementLine[] {
    const r = rng(seed);
    let bal = 500000;
    let day = 0;
    const out: StatementLine[] = [];
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) day++;
      const amt = Math.round((r() * 20000 + 1) * 100) / 100;
      const isCredit = r() < 0.5;
      bal = Math.round((bal + (isCredit ? amt : -amt)) * 100) / 100;
      const date = new Date(Date.UTC(2026, 3, 1) + day * 86_400_000).toISOString().slice(0, 10);
      out.push(L(date, isCredit ? 0 : Math.round(amt), isCredit ? Math.round(amt) : 0, Math.round(bal)));
    }
    return out;
  }

  it.each([1, 7, 42, 2026, 4523])("seed %i: 1,449 paise lines never read as missing lines", (seed) => {
    const r = checkStatement(randomStatement(seed, 1449), 500000)!;
    expect(r.gaps).toEqual([]);
    expect(["match", "rounding"]).toContain(r.verdict);
    expect(r.lineCount).toBe(1449);
    expect(Math.abs(r.roundingDrift)).toBeLessThanOrEqual(r.roundingAllowance);
  });

  it("a missing ₹500 line among paise lines is still a gap, around its date", () => {
    const lines = randomStatement(7, 400);
    const i = 200;
    const d = lines[i].txn_date;
    // The bank had a ₹500 debit right after line i that was never imported: every later
    // running balance is ₹500 lower than the imported lines explain.
    const cut = [...lines.slice(0, i + 1), ...lines.slice(i + 1).map((l) => ({ ...l, balance_after: (l.balance_after as number) - 500 }))];
    const r = checkStatement(cut, 500000)!;
    expect(r.verdict).toBe("off");
    expect(r.gaps).toHaveLength(1);
    // The day is compared as a whole, so its own lines' paise rounding rides along (±a few ₹).
    expect(Math.abs(r.gaps[0].amount - 500)).toBeLessThanOrEqual(5);
    expect(r.gaps[0].after <= d && d <= r.gaps[0].by).toBe(true);
  });

  it("the opening, the gaps and the rounding add up to the total difference", () => {
    const r = checkStatement(randomStatement(42, 300), 499000)!;
    const sum = r.openingDifference + r.gaps.reduce((s, g) => s + g.amount, 0) + r.roundingDrift;
    expect(sum).toBe(r.difference);
  });
});
