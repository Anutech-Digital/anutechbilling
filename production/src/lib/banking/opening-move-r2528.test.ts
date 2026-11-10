/**
 * R-2528 — review follow-ups of R-2522 (rv-r2522, 6 Nov 2026).
 *
 *  1. Only real paise rounding may be taken as rounding. R-2522 used the bank's own balance when
 *     the summed rupee figure was within least(floor(n/2)+1, 25) of it — so on a 48+ line
 *     statement a missing ₹17.70 SMS-charge line was "rounding". Now the meeting point is compared
 *     in PAISE: a statement line keeps its paise (amount_paise / balance_paise from the parser),
 *     the only rounding left is the opening's (≤ 50 paise), and anything more is a difference the
 *     owner must accept with a reason.
 *  2. Preview and server use ONE rule: a line dated AFTER the old opening date whose value date
 *     equals the old date is a line of that day — never inside the closing before it (the SQL
 *     never counted it; the preview did). The summed figure adds whole-rupee amounts line by line,
 *     as the database stores them.
 * Same cases as supabase/tests/r2528_bank_opening_rounding.test.sql.
 */
import { describe, expect, it } from "vitest";
import { openingMoveCheck } from "./opening-move";
import { openingBalanceFromStatement } from "./opening-balance";
import { parseStatement } from "./statement-parse";
import { SUBHVISION_CSV } from "./opening-move-r2522.fixture";

const HEADER = "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance";
const two = (n: number) => n.toFixed(2);

/** 51 × ₹10.00 fees; the bank also took a ₹17.70 SMS charge on 30 Sep that the file LEFT OUT
    (its balances still include it). Starts at ₹10,000.00; closing ₹9,472.30 → old opening ₹9,472. */
function smsChargeMissing(): string {
  const lines = [HEADER];
  let bal = 1_000_000; // paise
  for (let i = 1; i <= 50; i++) {
    bal -= 1000;
    lines.push(`01/06/25,FEE ${i},S${i},01/06/25,10.00,,${two(bal / 100)}`);
  }
  bal -= 1770; // the SMS charge — not in the file
  bal -= 1000;
  lines.push(`31/03/26,FEE LAST,SZ,31/03/26,10.00,,${two(bal / 100)}`);
  return lines.join("\n");
}

describe("R-2528 · a missing small line is not rounding", () => {
  it("51 lines missing a ₹17.70 SMS charge: refused (+₹18), not taken as rounding", () => {
    const rows = parseStatement(smsChargeMissing()).rows;
    expect(rows).toHaveLength(51);
    const c = openingMoveCheck({
      rows, newOpening: 10000, newDate: "2025-04-01", oldOpening: 9472, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ kind: "earlier", matches: false, difference: 18, roundingDrift: 0 });
  });

  it("the parser keeps a line's paise (only when it has paise)", () => {
    const rows = parseStatement(SUBHVISION_CSV).rows;
    expect(rows[0]).toMatchObject({ debit: 500001, amount_paise: 50000050, balance_after: 1520918, balance_paise: 152091846 });
    expect(rows[4]).toMatchObject({ credit: 37170, balance_paise: 90355193 });
    expect(rows[4].amount_paise).toBeUndefined(); // ₹37,170.00 — whole rupees, nothing to keep
  });

  it("SUBHVISION (FY 25-26) still matches honestly: paise differ by 4, today's balance moves −₹2", () => {
    // Bank: 20,20,918.96 − 5,00,000.50 − 6,55,236.50 + 1,000.47 − 300.50 + 37,170.00 = 9,03,551.93.
    // App opening ₹20,20,919 (+0.04) → summed in paise 9,03,551.97 vs the bank's 9,03,551.93.
    // In whole rupees the three .50 amounts round up (−1.50) and 1,000.47 down (−0.47): ₹2 short.
    const rows = parseStatement(SUBHVISION_CSV).rows;
    const c = openingMoveCheck({
      rows, newOpening: 2020919, newDate: "2025-04-01", oldOpening: 903552, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ matches: true, balanceOnOldDate: 903552, difference: 0, roundingDrift: -2, linesOnOldDate: 1 });
  });

  it("lines whose paise are not known (already in the app) allow at most ₹1 of rounding", () => {
    // The statement's window lines were imported earlier (whole rupees only); ₹2 apart is refused.
    const existing = [
      { txn_date: "2026-03-10", debit: 101, credit: 0, balance_after: 900 },
      { txn_date: "2026-03-20", debit: 101, credit: 0, balance_after: 800 },
    ];
    const c = openingMoveCheck({
      rows: [], newRows: [], existingInWindow: existing,
      newOpening: 1000, newDate: "2026-03-01", oldOpening: 800, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ matches: false, balanceOnOldDate: 798, difference: -2 });
  });

  it("lines already in the app with their stored paise (net_paise) compare in paise — as the database does", () => {
    // 4 × ₹10.50 imported earlier (stored ₹11 each): whole rupees say ₹956, the bank and the paise ₹958.
    const existing = Array.from({ length: 4 }, (_, i) => ({
      txn_date: "2026-03-10", debit: 11, credit: 0, net_paise: -1050,
      balance_after: Math.round((100000 - 1050 * (i + 1)) / 100), balance_after_paise: 100000 - 1050 * (i + 1),
    }));
    const args = { rows: [], newRows: [], newOpening: 1000, newDate: "2026-03-01", oldOpening: 958, oldDate: "2026-04-01", accountHasMoney: true };
    expect(openingMoveCheck({ ...args, existingInWindow: existing })).toMatchObject({ matches: true, roundingDrift: -2 });
    // An edited line's stale paise (no longer its rupees) are not trusted → whole rupees, refused.
    const edited = existing.map((l, i) => (i === 0 ? { ...l, debit: 50 } : l));
    expect(openingMoveCheck({ ...args, existingInWindow: edited })).toMatchObject({ matches: false });
  });

  it("the suggested opening is worked out in paise (at most 50 paise off the bank's)", () => {
    // First line: ₹10.50 out leaving ₹1,000.50 → the bank's opening is ₹1,011.00 (rupees alone: 1,001 + 11 = 1,012).
    const rows = parseStatement([HEADER, "02/03/26,FEE,X1,02/03/26,10.50,,1000.50"].join("\n")).rows;
    expect(openingBalanceFromStatement(rows, "2026-03-01")).toMatchObject({ ok: true, amount: 1011 });
  });
});

describe("R-2528 · preview = server", () => {
  it("a line dated after the old date with value date = the old date is never counted", () => {
    const st = [
      { txn_date: "2026-03-10", debit: 0, credit: 300, balance_after: 800 },
      { txn_date: "2026-04-02", value_date: "2026-04-01", debit: 0, credit: 200, balance_after: 1000 },
    ];
    const c = openingMoveCheck({
      rows: st, newOpening: 500, newDate: "2026-03-01", oldOpening: 1000, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ kind: "earlier", matches: false, difference: -200, linesOnOldDate: 0 });
  });

  it("the summed figure adds whole-rupee amounts line by line, as the database stores them", () => {
    // 4 × ₹10.50 with no balance column: stored ₹11 each → ₹956 (raw paise would say ₹958).
    const st = Array.from({ length: 4 }, () => ({ txn_date: "2026-03-10", debit: 10.5, credit: 0, balance_after: null }));
    const c = openingMoveCheck({
      rows: st, newOpening: 1000, newDate: "2026-03-01", oldOpening: 958, oldDate: "2026-04-01", accountHasMoney: true,
    });
    expect(c).toMatchObject({ matches: false, balanceOnOldDate: 956, difference: -2 });
  });
});
