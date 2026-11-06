/**
 * R-2522 — the opening move is compared where the statement MEETS the app's existing data.
 *
 * The real case (staging, HDFC 4523, FY 25-26 statement, 6 Nov 2026): its last line SUBHVISION
 * NEFT ₹37,170 is dated 01/04/26 with value date 31/03/26; HDFC counts it in the 31 Mar 2026
 * closing ₹9,03,551.93 = the account's opening ₹9,03,552 as of 1 Apr 2026, and the app does not
 * have it yet. R-2497 summed only lines dated BEFORE 1 Apr 2026 → −₹37,172 (−₹37,170 for the line,
 * −₹2 paise rounding over the rupee amounts) and refused. The fixture keeps that shape, paise and
 * all: 20,20,918.96 start; rounded amounts sum to ₹8,66,380 where the bank says ₹8,66,381.93.
 * Same fixture as supabase/tests/r2522_bank_opening_meet.test.sql.
 */
import { describe, expect, it } from "vitest";
import { meetDate, openingMoveCheck, statementBalanceAtMeet } from "./opening-move";
import { parseStatement } from "./statement-parse";
import { SUBHVISION_CSV } from "./opening-move-r2522.fixture";

const rows = parseStatement(SUBHVISION_CSV).rows;
const base = { newOpening: 2020919, newDate: "2025-04-01", oldOpening: 903552, oldDate: "2026-04-01", accountHasMoney: true };

describe("statement parse keeps the value date (R-2522)", () => {
  it("HDFC's Value Dt column is read; the txn date stays the Date column", () => {
    const s = rows[rows.length - 1];
    expect(s).toMatchObject({ txn_date: "2026-04-01", value_date: "2026-03-31", credit: 37170, balance_after: 903552 });
    expect(rows.map((r) => r.debit + r.credit)).toEqual([500001, 655237, 1000, 301, 37170]);
  });
  it("a file with only a Value Date column uses it as the date (no separate value date)", () => {
    const r = parseStatement("Value Date,Description,Debit,Credit\n05/04/2026,FEE,10,").rows[0];
    expect(r.txn_date).toBe("2026-04-05");
  });
});

describe("openingMoveCheck at the meeting point (R-2522)", () => {
  it("SUBHVISION shape: matches the old opening — no override needed", () => {
    const c = openingMoveCheck({ ...base, rows });
    expect(c).toMatchObject({
      kind: "earlier", balanceOnOldDate: 903552, difference: 0, matches: true,
      linesOnOldDate: 1, roundingDrift: -2,
    });
  });

  it("the R-2497 rule's figure, for the record: −37,172 when the 1 Apr line is left out", () => {
    // The same statement, but the app already has SUBHVISION → it is existing data, not counted.
    const c = openingMoveCheck({ ...base, rows, newRows: rows.slice(0, 4) });
    expect(c).toMatchObject({ kind: "earlier", balanceOnOldDate: 866382, matches: false, linesOnOldDate: 0 });
  });

  it("a line missing from the statement is still a difference (the summed figure is used)", () => {
    const missing = rows.filter((r) => r.description !== "FD BOOKED");
    const c = openingMoveCheck({ ...base, rows: missing });
    expect(c).toMatchObject({ kind: "earlier", matches: false, difference: 655235, roundingDrift: 0 });
  });

  it("value date: a line dated after the old opening counts when its value date is on/before it", () => {
    const st = [
      { txn_date: "2026-03-10", debit: 0, credit: 300, balance_after: 800 },
      { txn_date: "2026-04-02", value_date: "2026-03-31", debit: 0, credit: 200, balance_after: 1000 },
    ];
    const args = { newOpening: 500, newDate: "2026-03-01", oldOpening: 1000, oldDate: "2026-04-01", accountHasMoney: true };
    expect(openingMoveCheck({ ...args, rows: st })).toMatchObject({ matches: true, balanceOnOldDate: 1000 });
    const noValue = st.map(({ value_date: _v, ...r }) => r);
    expect(openingMoveCheck({ ...args, rows: noValue })).toMatchObject({ matches: false, difference: -200 });
  });

  it("a manual line already in the app between the dates is counted, as the database counts it", () => {
    // Real case: hand-entered "EMI 1 Thar Roxx" ₹27,764 on 3 Mar 2026; the bank's EMI is ₹30,183 on 5 Mar.
    const st = [{ txn_date: "2026-03-05", debit: 30183, credit: 0, balance_after: 10000 }];
    const manual = [{ txn_date: "2026-03-03", debit: 27764, credit: 0, balance_after: null }];
    const args = { newOpening: 40183, newDate: "2026-03-01", oldOpening: 10000, oldDate: "2026-04-01", accountHasMoney: true, rows: st };
    expect(openingMoveCheck(args)).toMatchObject({ matches: true });
    expect(openingMoveCheck({ ...args, existingInWindow: manual })).toMatchObject({ matches: false, difference: -27764 });
  });

  it("existing statement lines in the window are not counted twice", () => {
    const st = [{ txn_date: "2026-03-05", debit: 30183, credit: 0, balance_after: 10000 }];
    const c = openingMoveCheck({
      newOpening: 40183, newDate: "2026-03-01", oldOpening: 10000, oldDate: "2026-04-01", accountHasMoney: true,
      rows: st, newRows: [], existingInWindow: st,
    });
    expect(c).toMatchObject({ matches: true, balanceOnOldDate: 10000 });
  });
});

describe("helpers (R-2522)", () => {
  it("meetDate takes the earlier value date only", () => {
    expect(meetDate({ txn_date: "2026-04-01", value_date: "2026-03-31" })).toBe("2026-03-31");
    expect(meetDate({ txn_date: "2026-04-01", value_date: "2026-04-03" })).toBe("2026-04-01");
    expect(meetDate({ txn_date: "2026-04-01" })).toBe("2026-04-01");
  });
  it("statementBalanceAtMeet: the day's one end, null when a line has no balance", () => {
    expect(statementBalanceAtMeet(rows.slice(0, 4))).toBe(866382);
    expect(statementBalanceAtMeet([{ txn_date: "2026-03-31", debit: 1, credit: 0, balance_after: null }])).toBeNull();
  });
});
