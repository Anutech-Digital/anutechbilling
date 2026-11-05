/**
 * R-2497 — moving a bank account's opening balance from a statement must keep today's balance.
 * Owner example (Excel Technologies, HDFC 4523): opening ₹1,00,000 as of 1 Apr 2026; the FY 25-26
 * statement starts at ₹70,000 on 1 Apr 2025 and its lines net +₹30,000.
 */
import { describe, expect, it } from "vitest";
import { linesBeforeOpening, openingMoveCheck } from "./opening-move";

const fy2526 = [
  { txn_date: "2025-04-15", debit: 0, credit: 80000 },
  { txn_date: "2025-10-01", debit: 50000, credit: 0 },
  // a line of the new year, also on the statement (a duplicate of what is stored)
  { txn_date: "2026-05-10", debit: 0, credit: 50000 },
];

describe("openingMoveCheck (R-2497)", () => {
  it("earlier date, statement agrees → matches, balance on the old date = old opening", () => {
    const c = openingMoveCheck({
      rows: fy2526, newOpening: 70000, newDate: "2025-04-01",
      oldOpening: 100000, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toEqual({
      kind: "earlier", oldDate: "2026-04-01", oldOpening: 100000,
      balanceOnOldDate: 100000, difference: 0, matches: true,
    });
  });

  it("earlier date, statement does not agree → the difference, not matching", () => {
    const c = openingMoveCheck({
      rows: fy2526, newOpening: 60000, newDate: "2025-04-01",
      oldOpening: 100000, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ kind: "earlier", balanceOnOldDate: 90000, difference: -10000, matches: false });
  });

  it("₹1 of paise rounding still matches", () => {
    const c = openingMoveCheck({
      rows: fy2526, newOpening: 70001, newDate: "2025-04-01",
      oldOpening: 100000, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ kind: "earlier", matches: true, difference: 1 });
  });

  it("a fresh account (no money yet) has nothing to keep", () => {
    expect(openingMoveCheck({
      rows: fy2526, newOpening: 70000, newDate: "2025-04-01",
      oldOpening: 0, oldDate: "2026-11-01", accountHasMoney: false,
    })).toEqual({ kind: "none" });
  });

  it("same or later date → the app checks it on save (kind later)", () => {
    expect(openingMoveCheck({
      rows: fy2526, newOpening: 100000, newDate: "2026-04-01",
      oldOpening: 100000, oldDate: "2026-04-01", accountHasMoney: true,
    })).toEqual({ kind: "later", oldDate: "2026-04-01" });
  });
});

describe("linesBeforeOpening (R-2497)", () => {
  it("counts lines dated before the opening date — they are not in the balance", () => {
    expect(linesBeforeOpening(fy2526, "2026-04-01")).toBe(2);
    expect(linesBeforeOpening(fy2526, "2025-04-01")).toBe(0);
    expect(linesBeforeOpening(fy2526, null)).toBe(0);
  });
});
