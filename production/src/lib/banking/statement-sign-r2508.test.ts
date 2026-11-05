/**
 * R-2508 (5 Nov 2026) — follow-ups from the independent review of R-2495.
 *
 * 1. Rounding: the sign goes on AFTER rounding the size, so "(20000.50)", "20000.50-" and
 *    "-20000.50" are the same ₹ — a withdrawal of 20000.50 and its reversal net to 0, not ₹1.
 * 2. A minus in an amount column is a reversal (money back in) only when the FILE shows it:
 *    the running balance moves up by that amount. Balance moves down → it was money out. No
 *    balance to tell → the line is marked "check sign" and the import waits for the owner.
 *    The ≥3-negatives "signed column" rule is unchanged.
 *
 * Fixtures are made up (synthetic narrations and amounts) in HDFC's column layout.
 */
import { describe, it, expect } from "vitest";
import {
  parseAmount, parseStatementRows, settleReversals, signCheckCount, applySignChoice, countReversals, signChoiceDirections,
  type ParsedRow,
} from "./statement-parse";

const HEAD_BAL = ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"];
const HEAD_NO_BAL = ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt."];

describe("R-2508 — the sign goes on after rounding", () => {
  it("(20000.50), 20000.50- and -20000.50 are the same amount", () => {
    expect(parseAmount("(20000.50)")).toBe(-20001);
    expect(parseAmount("-20000.50")).toBe(-20001);
    expect(parseAmount("20000.50-")).toBe(-20001);
    expect(parseAmount("20000.50")).toBe(20001);
    expect(parseAmount("-0.40")).toBe(0);
    expect(Object.is(parseAmount("-0.40"), -0)).toBe(false);
  });

  it("a 20000.50 withdrawal and its -20000.50 reversal net to zero", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["09/09/25", "DEMO OPENING CREDIT", "", "5000.00", "105000.50"],
      ["10/09/25", "ATW-DEMO", "20000.50", "", "85000.00"],
      ["10/09/25", "ATW-DEMO", "-20000.50", "", "105000.50"],
    ]);
    const atm = p.rows.filter((r) => r.description.startsWith("ATW-"));
    expect(atm.reduce((n, r) => n + r.credit - r.debit, 0)).toBe(0);
  });
});

describe("R-2508 — one negative WITH a balance column: the balance decides", () => {
  it("balance goes back UP by the amount → a reversal (money in), nothing to check", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00", "105000.00"],
      ["10/09/25", "ATW-DEMO", "20000.00", "", "85000.00"],
      ["10/09/25", "ATW-DEMO", "-20000.00", "", "105000.00"],
      ["11/09/25", "UPI-DEMO SHOP", "1000.00", "", "104000.00"],
    ]);
    const back = p.rows[2];
    expect(back).toMatchObject({ debit: 0, credit: 20000, reversal: true });
    expect(back.checkSign).toBeUndefined();
    expect(signCheckCount(p.rows)).toBe(0);
  });

  it("balance goes DOWN by the amount → it was money out, booked as a withdrawal", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00", "105000.00"],
      ["10/09/25", "DEMO RENT", "-20000.00", "", "85000.00"],
      ["11/09/25", "UPI-DEMO SHOP", "1000.00", "", "84000.00"],
    ]);
    expect(p.rows[1]).toMatchObject({ debit: 20000, credit: 0, description: "DEMO RENT" });
    expect(p.rows[1].reversal).toBeUndefined();
    expect(p.rows[1].checkSign).toBeUndefined();
    expect(countReversals(p.rows)).toBe(0);
    expect(p.warnings.join(" ")).not.toMatch(/reversal/);
  });

  it("newest-first file: the balance chain is read the other way round", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["11/09/25", "UPI-DEMO SHOP", "1000.00", "", "104000.00"],
      ["10/09/25", "ATW-DEMO", "-20000.00", "", "105000.00"],
      ["10/09/25", "ATW-DEMO", "20000.00", "", "85000.00"],
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00", "105000.00"],
      ["08/09/25", "NEFT CR-DEMO 2", "", "2000.00", "100000.00"],
    ]);
    expect(p.rows[1]).toMatchObject({ debit: 0, credit: 20000, reversal: true });
    expect(p.rows[1].checkSign).toBeUndefined();
  });

  it("the balance does not move by the amount either way → check sign", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00", "105000.00"],
      ["10/09/25", "ATW-DEMO", "-20000.00", "", "99999.00"],
    ]);
    expect(p.rows[1].checkSign).toBe(true);
    expect(signCheckCount(p.rows)).toBe(1);
  });
});

describe("R-2508 — one negative WITHOUT a balance column: never guessed", () => {
  const rows = () => parseStatementRows([
    HEAD_NO_BAL,
    ["09/09/25", "NEFT CR-DEMO", "", "5000.00"],
    ["10/09/25", "DEMO RENT", "-20000.00", ""],
    ["11/09/25", "UPI-DEMO SHOP", "1000.00", ""],
  ]);

  it("the line is marked 'check sign' (shown as money in for now), and counted", () => {
    const p = rows();
    expect(p.rows[1]).toMatchObject({ debit: 0, credit: 20000, reversal: true, checkSign: true });
    expect(signCheckCount(p.rows)).toBe(1);
    // the plain reversal sentence is not said for a line that is not settled yet
    expect(countReversals(p.rows)).toBe(0);
  });

  it("owner says money OUT → a 20,000 withdrawal, no mark left", () => {
    const p = rows();
    const after = applySignChoice(p.rows, 1, "printed");
    expect(after[1]).toMatchObject({ debit: 20000, credit: 0, description: "DEMO RENT" });
    expect(after[1].reversal).toBeUndefined();
    expect(after[1].checkSign).toBeUndefined();
    expect(signCheckCount(after)).toBe(0);
    expect(after[0]).toBe(p.rows[0]);
  });

  it("owner says money IN → a confirmed reversal", () => {
    const after = applySignChoice(rows().rows, 1, "reversal");
    expect(after[1]).toMatchObject({ debit: 0, credit: 20000, reversal: true });
    expect(after[1].description).toMatch(/\(reversal\)$/);
    expect(after[1].checkSign).toBeUndefined();
    expect(signCheckCount(after)).toBe(0);
  });

  it("two negatives (below the signed-column rule) → both wait for the owner", () => {
    const p = parseStatementRows([
      HEAD_NO_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00"],
      ["10/09/25", "DEMO RENT", "-20000.00", ""],
      ["11/09/25", "DEMO FUEL", "-1000.00", ""],
    ]);
    expect(signCheckCount(p.rows)).toBe(2);
  });
});

describe("R-2508 — the ≥3 signed-column rule is unchanged", () => {
  it("three withdrawals written -N, no balance column → plain money out, nothing to check", () => {
    const p = parseStatementRows([
      HEAD_NO_BAL,
      ["01/10/25", "DEMO SHOP A", "-100", ""],
      ["02/10/25", "DEMO SHOP B", "-200", ""],
      ["03/10/25", "DEMO SALARY", "", "1000"],
      ["04/10/25", "DEMO SHOP C", "-300", ""],
    ]);
    expect(p.rows.map((r) => [r.debit, r.credit])).toEqual([[100, 0], [200, 0], [0, 1000], [300, 0]]);
    expect(signCheckCount(p.rows)).toBe(0);
    expect(countReversals(p.rows)).toBe(0);
  });
});

describe("R-2508 — settleReversals is safe to run twice (CSV parse, then the dialog's last gate)", () => {
  it("same answer on the second run", () => {
    const p = parseStatementRows([
      HEAD_NO_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00"],
      ["10/09/25", "DEMO RENT", "-20000.00", ""],
    ]);
    const again: ParsedRow[] = settleReversals(p.rows);
    expect(again).toEqual(p.rows);
  });
});

describe("R-2508 review — no coincidence decides, a Deposit-column minus too", () => {
  it("oldest-first, the reversal is the first line and the next line is an equal deposit → still check sign", () => {
    const p = parseStatementRows([
      HEAD_BAL,
      ["10/09/25", "ATW-DEMO", "-20000.00", "", "105000.00"],
      ["11/09/25", "NEFT CR-DEMO", "", "20000.00", "125000.00"],
    ]);
    expect(p.rows[0].checkSign).toBe(true);
  });

  it("one chunk of a longer PDF (final: false) never settles 'money out' alone — it waits", () => {
    const rows: ParsedRow[] = [
      { txn_date: "2025-09-09", description: "NEFT CR-DEMO", debit: 0, credit: 5000, balance_after: 105000, reference: null },
      { txn_date: "2025-09-10", description: "DEMO RENT (reversal)", debit: 0, credit: 20000, balance_after: 85000, reference: null, reversal: true },
    ];
    const chunk = settleReversals(rows, { final: false });
    expect(chunk[1]).toMatchObject({ checkSign: true, reversal: true, description: "DEMO RENT" });
    const whole = settleReversals(chunk);
    expect(whole[1]).toMatchObject({ debit: 20000, credit: 0, description: "DEMO RENT" });
    expect(whole[1].checkSign).toBeUndefined();
  });

  it("a Deposit-column minus with no balance: 'reversal' is money OUT, 'printed' money IN", () => {
    const p = parseStatementRows([
      HEAD_NO_BAL,
      ["09/09/25", "NEFT CR-DEMO", "", "5000.00"],
      ["10/09/25", "DEMO REFUND", "", "-750.00"],
    ]);
    expect(p.rows[1]).toMatchObject({ debit: 750, credit: 0, checkSign: true });
    expect(signChoiceDirections(p.rows[1])).toMatchObject({ reversal: "out", printed: "in", amount: 750, column: "Deposit" });
    expect(applySignChoice(p.rows, 1, "reversal")[1]).toMatchObject({ debit: 750, credit: 0 });
    expect(applySignChoice(p.rows, 1, "printed")[1]).toMatchObject({ debit: 0, credit: 750 });
  });
});
