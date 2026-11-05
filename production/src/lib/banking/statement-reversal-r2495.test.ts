/**
 * R-2495 (5 Nov 2026) — a NEGATIVE debit is a reversal: money back IN, not a line to skip.
 *
 * Owner's path: Banking → bank account → Import statement → HDFC FY 2025-26 .xls. On one day
 * HDFC printed a failed ATM withdrawal as two lines — "ATW-…" debit 20000, then the same
 * narration with debit -20000 and the balance back up by 20,000. The parser clamped the
 * negative to 0, skipped the line as "both amounts zero", and the running-balance check then
 * said "This file is incomplete — lines worth ₹20,000 are missing". The file was complete.
 *
 * Fixture below is made up (synthetic narrations, made-up amounts) in HDFC's column layout.
 */
import { describe, it, expect } from "vitest";
import { parseStatement, parseStatementRows, signedAmounts, parseAmount, columnIsSigned, countReversals } from "./statement-parse";
import { checkStatement } from "./statement-check";
import { planBankImport, indexBankLines } from "@/lib/queries/bank";

const HEADER = "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance";
const HDFC_LIKE = [
  "Demo Bank Statement of account",
  "",
  HEADER,
  "09/09/25,NEFT CR-DEMO0001-SAMPLE TRADERS,0000000000000001,09/09/25,,5000.00,105000.50",
  "10/09/25,ATW-000000XXXXXX0000-TESTATM1-DEMOCITY,0000000000000002,10/09/25,20000.00,,85000.50",
  "10/09/25,ATW-000000XXXXXX0000-TESTATM1-DEMOCITY,0000000000000002,10/09/25,-20000.00,,105000.50",
  "11/09/25,UPI-SAMPLE SHOP-DEMO@BANK,0000000000000003,11/09/25,1000.00,,104000.50",
].join("\n");

describe("R-2495 — negative debit = reversal (money in)", () => {
  it("keeps both ATM lines: one out, one back in, marked as a reversal", () => {
    const p = parseStatement(HDFC_LIKE);
    expect(p.skipped).toBe(0);
    expect(p.rows).toHaveLength(4);
    const [out, back] = p.rows.filter((r) => r.description.startsWith("ATW-"));
    expect(out).toMatchObject({ txn_date: "2025-09-10", debit: 20000, credit: 0 });
    expect(out.reversal).toBeUndefined();
    expect(back).toMatchObject({ txn_date: "2025-09-10", debit: 0, credit: 20000, reversal: true });
    expect(back.description).toMatch(/\(reversal\)$/);
    expect(p.warnings.join(" ")).toMatch(/1 line .*negative amount.*reversal/i);
  });

  it("the running-balance check passes — nothing reported missing", () => {
    const p = parseStatement(HDFC_LIKE);
    const check = checkStatement(p.rows, 100_001)!;
    expect(check.gaps).toEqual([]);
    expect(check.verdict).not.toBe("off");
  });

  it("a negative credit is a debit (money out), also marked", () => {
    const p = parseStatementRows([
      ["Date", "Description", "Debit", "Credit", "Balance"],
      ["01/10/25", "DEMO REFUND REVERSED", "", "-750", "9250"],
    ]);
    expect(p.skipped).toBe(0);
    expect(p.rows[0]).toMatchObject({ debit: 750, credit: 0, reversal: true });
  });

  it("a line with BOTH amounts, or truly zero, is still skipped", () => {
    const p = parseStatementRows([
      ["Date", "Description", "Debit", "Credit"],
      ["01/10/25", "BOTH SIDES", "100", "200"],
      ["02/10/25", "ZERO LINE", "0", "0"],
      ["03/10/25", "NOTHING", "", ""],
    ]);
    expect(p.rows).toHaveLength(0);
    expect(p.skipped).toBe(3);
  });

  it("signedAmounts folds the sign onto the right side", () => {
    expect(signedAmounts(-20000, 0)).toEqual({ debit: 0, credit: 20000, reversal: true });
    expect(signedAmounts(0, -750)).toEqual({ debit: 750, credit: 0, reversal: true });
    expect(signedAmounts(500, 0)).toEqual({ debit: 500, credit: 0, reversal: false });
    expect(signedAmounts(0, 0)).toEqual({ debit: 0, credit: 0, reversal: false });
  });
});

describe("R-2495 — dedupe keeps the ATM pair as two lines", () => {
  it("both lines are new on a first import", () => {
    const p = parseStatement(HDFC_LIKE);
    const plan = planBankImport(p.rows, indexBankLines([]));
    expect(plan.fresh).toHaveLength(4);
    expect(plan.fresh.filter((r) => r.description.startsWith("ATW-")).map((r) => [r.debit, r.credit])).toEqual([[20000, 0], [0, 20000]]);
  });

  it("books holding only the withdrawal → the reversal still comes in (also without a balance column)", () => {
    const p = parseStatement(HDFC_LIKE);
    const withdrawal = p.rows.find((r) => r.debit === 20000)!;
    expect(planBankImport(p.rows, indexBankLines([withdrawal])).fresh).toHaveLength(3);
    const noBal = p.rows.map((r) => ({ ...r, balance_after: null }));
    const plan = planBankImport(noBal, indexBankLines([{ ...withdrawal, balance_after: null }]));
    expect(plan.fresh.map((r) => [r.debit, r.credit])).toContainEqual([0, 20000]);
    expect(plan.fresh).toHaveLength(3);
  });

  it("re-uploading the same file adds nothing", () => {
    const p = parseStatement(HDFC_LIKE);
    expect(planBankImport(p.rows, indexBankLines(p.rows)).fresh).toHaveLength(0);
  });
});

describe("R-2495 review — what a minus is NOT", () => {
  it("both cells filled with opposite signs are still skipped, never added up", () => {
    expect(signedAmounts(100, -100)).toEqual({ debit: 100, credit: 100, reversal: false });
    const p = parseStatementRows([
      ["Date", "Description", "Debit", "Credit"],
      ["01/10/25", "MISALIGNED", "100", "-100"],
    ]);
    expect(p.rows).toHaveLength(0);
    expect(p.skipped).toBe(1);
  });

  it("an export that writes EVERY withdrawal with a minus is a signed column, not reversals", () => {
    const p = parseStatementRows([
      ["Date", "Description", "Debit", "Credit", "Balance"],
      ["01/10/25", "DEMO SHOP A", "-100", "", "900"],
      ["02/10/25", "DEMO SHOP B", "-200", "", "700"],
      ["03/10/25", "DEMO SALARY", "", "1000", "1700"],
      ["04/10/25", "DEMO SHOP C", "-300", "", "1400"],
    ]);
    expect(p.rows.map((r) => [r.debit, r.credit])).toEqual([[100, 0], [200, 0], [0, 1000], [300, 0]]);
    expect(countReversals(p.rows)).toBe(0);
    expect(p.warnings.join(" ")).not.toMatch(/reversal/);
  });

  it("one lone reversal in a short file is still a reversal", () => {
    expect(columnIsSigned([-20000])).toBe(false);
    expect(columnIsSigned([-1, -2, -3, 4])).toBe(true);
  });

  it("(20,000.00) and 20,000.00- are negatives too", () => {
    expect(parseAmount("(20,000.00)")).toBe(-20000);
    expect(parseAmount("20,000.00-")).toBe(-20000);
    expect(parseAmount("-20,000.00")).toBe(-20000);
    expect(parseAmount("1,234.40 Cr")).toBe(1234);
    const p = parseStatementRows([
      ["Date", "Description", "Debit", "Credit"],
      ["10/09/25", "ATW-DEMO", "20,000.00", ""],
      ["10/09/25", "ATW-DEMO", "(20,000.00)", ""],
      ["11/09/25", "ATW-DEMO-2", "5,000.00", ""],
      ["11/09/25", "ATW-DEMO-2", "5,000.00-", ""],
    ]);
    expect(p.rows.map((r) => [r.debit, r.credit])).toEqual([[20000, 0], [0, 20000], [5000, 0], [0, 5000]]);
  });
});
