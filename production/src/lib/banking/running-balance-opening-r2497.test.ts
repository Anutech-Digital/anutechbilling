/**
 * R-2497 — the account page's "Balance in bank" and running Balance count only lines dated on/after
 * the opening date (the opening is the balance at the START of that date), the same rule as
 * bank_account_current_balance() in the database.
 */
import { describe, expect, it } from "vitest";
import { bankBalanceOf, runningBalances } from "./running-balance";

const lines = [
  { id: "a", txn_date: "2025-04-15", debit: 0, credit: 80000, balance_after: 150000 },
  { id: "b", txn_date: "2025-10-01", debit: 50000, credit: 0, balance_after: 100000 },
  { id: "c", txn_date: "2026-05-10", debit: 0, credit: 50000, balance_after: 150000 },
];

describe("bank balance respects the opening date (R-2497)", () => {
  it("lines before the opening are not counted again", () => {
    expect(bankBalanceOf(lines, 100000, "2026-04-01")).toBe(150000);
  });

  it("no opening date given → every line (old callers unchanged)", () => {
    expect(bankBalanceOf(lines, 100000)).toBe(180000);
  });

  it("running balance: lines before the opening are marked not counted; the newest equals Balance in bank", () => {
    const r = runningBalances(lines, 100000, "2026-04-01");
    expect(r.get("a")?.beforeOpening).toBe(true);
    expect(r.get("b")?.beforeOpening).toBe(true);
    expect(r.get("c")?.beforeOpening).toBeUndefined();
    expect(r.get("c")?.balance).toBe(150000);
    expect(r.get("c")?.statementSays).toBeNull();
  });

  it("opening moved to 1 Apr 2025 (₹70,000): every line counted, same balance today", () => {
    expect(bankBalanceOf(lines, 70000, "2025-04-01")).toBe(150000);
    const r = runningBalances(lines, 70000, "2025-04-01");
    expect(r.get("a")?.balance).toBe(150000);
    expect(r.get("b")?.balance).toBe(100000);
  });
});
