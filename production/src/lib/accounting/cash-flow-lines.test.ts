import { describe, it, expect } from "vitest";
import { lineLabel, totalsByLabel, NOT_RECONCILED, activityOf, type CashFlowTxn } from "./cash-flow-lines";

describe("R-1839 owner drawings / capital in the cash flow", () => {
  it("is financing (the owner), labelled as such — never operating", () => {
    expect(activityOf({ matched_to_type: "owner_equity", category: null })).toBe("financing");
    expect(lineLabel({ matched_to_type: "owner_equity", category: null })).toBe("Owner drawings / capital");
  });
});

const t = (over: Partial<CashFlowTxn>): CashFlowTxn => ({
  id: Math.random().toString(36), bank_account_id: "a", txn_date: "2026-09-10",
  description: null, debit: 0, credit: 0, matched_to_type: null, category: null, ...over,
});

describe("lineLabel", () => {
  it("unreconciled says so, even when a category was guessed at import", () => {
    expect(lineLabel({ matched_to_type: null, category: "Bank Charges" })).toBe(NOT_RECONCILED);
  });
  it("an expense uses its category, else 'Expense'", () => {
    expect(lineLabel({ matched_to_type: "expense", category: "Travel" })).toBe("Travel");
    expect(lineLabel({ matched_to_type: "expense", category: null })).toBe("Expense");
  });
  it("names the other reconcile types", () => {
    expect(lineLabel({ matched_to_type: "salary", category: null })).toBe("Salary");
    expect(lineLabel({ matched_to_type: "statutory", category: null })).toBe("Tax & statutory");
    expect(lineLabel({ matched_to_type: "transfer", category: null })).toBe("Transfer (own accounts)");
    expect(lineLabel({ matched_to_type: "prepaid", category: "Advertising" })).toBe("Prepaid advance");
  });
});

describe("totalsByLabel", () => {
  const lines = [
    t({ debit: 52000, matched_to_type: "salary" }),
    t({ debit: 31000, matched_to_type: "salary" }),
    t({ debit: 94 }),
    t({ debit: 89432, matched_to_type: "statutory" }),
    t({ credit: 540000, matched_to_type: "payment" }),
  ];

  it("sums one side only, biggest first, with counts", () => {
    expect(totalsByLabel(lines, "out")).toEqual([
      { label: "Tax & statutory", amount: 89432, count: 1 },
      { label: "Salary", amount: 83000, count: 2 },
      { label: NOT_RECONCILED, amount: 94, count: 1 },
    ]);
    expect(totalsByLabel(lines, "in")).toEqual([{ label: "Customer payment", amount: 540000, count: 1 }]);
  });

  it("the label totals add up to the month's cash out", () => {
    const out = totalsByLabel(lines, "out").reduce((s, g) => s + g.amount, 0);
    expect(out).toBe(lines.reduce((s, l) => s + l.debit, 0));
  });
});

describe("cash flow by activity (direct method)", () => {
  const L = (over: Partial<CashFlowTxn>): CashFlowTxn => ({ id: "x", bank_account_id: "a", txn_date: "2026-08-10", description: null, debit: 0, credit: 0, matched_to_type: "expense", category: null, ...over });
  it("classifies from the reconciliation, keeps transfers and unreconciled lines apart", async () => {
    const { cashFlowByActivity, activityOf } = await import("./cash-flow-lines");
    expect(activityOf({ matched_to_type: "payment", category: null })).toBe("operating");
    expect(activityOf({ matched_to_type: "expense", category: "Equipment" })).toBe("investing");
    expect(activityOf({ matched_to_type: "manual", category: null })).toBe("financing");
    expect(activityOf({ matched_to_type: "transfer", category: null })).toBe("transfer");
    expect(activityOf({ matched_to_type: null, category: "Software" })).toBe("unreconciled");
    const f = cashFlowByActivity([
      L({ id: "1", credit: 100_000, matched_to_type: "payment" }),
      L({ id: "2", debit: 30_000, matched_to_type: "salary" }),
      L({ id: "3", debit: 80_000, category: "Equipment" }),
      L({ id: "4", credit: 500_000, matched_to_type: "manual" }),
      L({ id: "5", debit: 10_000, matched_to_type: "transfer" }),
      L({ id: "6", debit: 590, matched_to_type: null }),
    ]);
    expect(f.map((g) => [g.activity, g.net])).toEqual([["operating", 70_000], ["investing", -80_000], ["financing", 500_000], ["unreconciled", -590], ["transfer", -10_000]]);
  });
});
