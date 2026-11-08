/**
 * R-2611 — bulk "Money out · no vendor yet": the suggestion per line (same layers as the Reconcile
 * sheet's "Book as expense"), the confidence chip, what "Tick all high-confidence" ticks, and the
 * lines the bulk list never offers (government challans, loans, salary).
 */
import { describe, it, expect } from "vitest";
import {
  AUTO_TICK_MAX, BULK_MAX, bulkExcluded, bulkRows, expenseSuggestion, refuseBulkRow,
} from "./bulk-expense";
import type { CategoryRule } from "./categorise";

const kw = (t: string) => (/\bAWS\b|HOSTING/i.test(t) ? "Hosting" : /\bSWIGGY\b/i.test(t) ? "Staff Welfare" : null);
const rule: CategoryRule = { id: "r1", pattern: "FACEBK", category: "Advertising", direction: "debit" } as CategoryRule;
const line = (over: Partial<{ id: string; description: string; debit: number; credit: number; category: string | null; txn_date: string }>) => ({
  id: "t1", description: "UPI-SOMEONE", debit: 500, credit: 0, category: null, txn_date: "2025-06-01", ...over,
});

describe("expenseSuggestion", () => {
  it("a Category Rule is high confidence, with the rule's payee", () => {
    const s = expenseSuggestion(line({ description: "POS FACEBK ADS 1234" }), [rule], kw);
    expect(s).toMatchObject({ category: "Advertising", confidence: "high" });
  });
  it("a built-in keyword is medium", () => {
    expect(expenseSuggestion(line({ description: "NEFT AWS INDIA" }), [], kw)).toMatchObject({ category: "Hosting", confidence: "medium" });
  });
  it("the import's own category is medium", () => {
    expect(expenseSuggestion(line({ category: "Travel" }), [], kw)).toMatchObject({ category: "Travel", confidence: "medium" });
  });
  it("director narration is Director's Remuneration, never Salaries", () => {
    expect(expenseSuggestion(line({ description: "SALARY TO DIRECTOR" }), [], kw)?.category).toBe("Director's Remuneration");
  });
  it("a ₹1–₹10 debit with nothing else is a bank charge", () => {
    expect(expenseSuggestion(line({ debit: 1 }), [], kw)).toMatchObject({ category: "Bank Charges", confidence: "high" });
  });
  it("Salaries from the import is not suggested (Payroll's)", () => {
    expect(expenseSuggestion(line({ category: "Salaries" }), [], kw)).toBeNull();
  });
  it("nothing known → null (no guessed category)", () => {
    expect(expenseSuggestion(line({ description: "IMPS-XYZ" }), [], kw)).toBeNull();
  });
  it("money in → null", () => {
    expect(expenseSuggestion(line({ debit: 0, credit: 500, category: "Travel" }), [], kw)).toBeNull();
  });
});

describe("bulkExcluded", () => {
  it("government challans go to the statutory tile", () => {
    expect(bulkExcluded({ description: "ITNS 281 TDS CHALLAN", debit: 5000 })).toMatch(/TDS challan/);
    expect(bulkExcluded({ description: "GST/BANK REFERENCE NO: 1/CIN NO: 2", debit: 5000 })).toMatch(/GST/);
  });
  it("a loan / EMI / advance narration is not an expense", () => {
    expect(bulkExcluded({ description: "NEFT LOAN TO RAVI", debit: 50000 })).toMatch(/loan/i);
    expect(bulkExcluded({ description: "BAJAJ FIN EMI 12", debit: 5000 })).toMatch(/loan/i);
    expect(bulkExcluded({ description: "SALARY ADVANCE AMIT", debit: 5000 })).toMatch(/salary/i);
  });
  it("money in / zero is refused", () => {
    expect(bulkExcluded({ description: "X", debit: 0 })).toMatch(/money-out/);
  });
  it("an ordinary vendor line passes", () => {
    expect(bulkExcluded({ description: "UPI-AMAZON PAY", debit: 900 })).toBeNull();
  });
});

describe("bulkRows", () => {
  it("ticks only high-confidence rows under ₹1,00,000; excluded lines are left out", () => {
    const rows = bulkRows([
      line({ id: "a", description: "POS FACEBK ADS", debit: 99_999 }),
      line({ id: "b", description: "POS FACEBK ADS", debit: AUTO_TICK_MAX }),
      line({ id: "c", description: "NEFT AWS INDIA", debit: 2000 }),
      line({ id: "d", description: "ITNS 281 TDS", debit: 2000 }),
      line({ id: "e", description: "IMPS-XYZ", debit: 2000 }),
    ], [rule], kw);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "e"]);
    expect(rows.find((r) => r.id === "a")?.autoTick).toBe(true);
    expect(rows.find((r) => r.id === "b")?.autoTick).toBe(false);    // ≥ ₹1L: owner ticks it by hand
    expect(rows.find((r) => r.id === "c")?.autoTick).toBe(false);    // medium
    expect(rows.find((r) => r.id === "e")).toMatchObject({ category: "", autoTick: false });
  });
  it("the same counterparty keeps each row's own category", () => {
    const rows = bulkRows([
      line({ id: "a", description: "POS FACEBK ADS" }),
      line({ id: "b", description: "POS FACEBK ADS", category: "Travel" }),
    ], [rule], kw);
    expect(rows.map((r) => r.category)).toEqual(["Advertising", "Travel"]);
  });
});

describe("refuseBulkRow (server)", () => {
  it("refuses Salaries, unknown categories and challan lines", () => {
    expect(refuseBulkRow({ description: "X", debit: 10 }, "Salaries")).toMatch(/Payroll/);
    expect(refuseBulkRow({ description: "X", debit: 10 }, "Bribes")).toMatch(/category/);
    expect(refuseBulkRow({ description: "ITNS 281", debit: 10 }, "Hosting")).toMatch(/TDS/);
    expect(refuseBulkRow({ description: "AWS", debit: 10 }, "Hosting")).toBeNull();
  });
  it("BULK_MAX is 100", () => { expect(BULK_MAX).toBe(100); });
});
