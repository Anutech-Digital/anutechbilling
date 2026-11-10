import { describe, it, expect } from "vitest";
import { lineLabel, totalsByLabel, NOT_RECONCILED, activityOf, cashFlowByActivity, ACTIVITY_LABEL, LENDING_LABEL, type CashFlowTxn } from "./cash-flow-lines";

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

describe("R-2575 — AS-3: loans GIVEN are Investing, loans TAKEN / capital are Financing", () => {
  const A = (matched_to_type: string | null, lent?: boolean) =>
    activityOf({ matched_to_type, category: null, lent });

  it("Loans given (Give loan payout and the borrower's repayment) → investing", () => {
    expect(A("loan_given")).toBe("investing");
    const f = cashFlowByActivity([
      t({ id: "give", debit: 50_000, matched_to_type: "loan_given" }),
      t({ id: "back", credit: 10_000, matched_to_type: "loan_given" }),
    ]);
    expect(f.map((g) => [g.activity, g.cashIn, g.cashOut, g.net])).toEqual([["investing", 10_000, 50_000, -40_000]]);
  });

  it("advance / loan given booked on a bank line (balance-sheet asset) → investing, both ways", () => {
    expect(A("bs_item", true)).toBe("investing");
  });

  it("loan received / director loan (liability) and owner capital (equity) → financing", () => {
    expect(A("bs_item", false)).toBe("financing");
    expect(lineLabel({ matched_to_type: "bs_item", category: null, lent: false })).toBe("Capital / loans (balance sheet)");
  });

  it("a bs_item line whose booking could not be read stays financing (as before)", () => {
    expect(A("bs_item")).toBe("financing");
  });

  it("old hand-marked ('manual') lines: a loan / advance given → investing, the rest financing", () => {
    expect(A("manual", true)).toBe("investing");
    expect(A("manual", false)).toBe("financing");
    expect(A("manual")).toBe("financing");
  });

  it("one label for money lent, whichever way it was booked — the label and the activity agree", () => {
    for (const l of [
      { matched_to_type: "loan_given", category: null },
      { matched_to_type: "bs_item", category: null, lent: true },
      { matched_to_type: "manual", category: null, lent: true },
    ]) {
      expect(lineLabel(l)).toBe(LENDING_LABEL);
      expect(activityOf(l)).toBe("investing");
    }
    const out = totalsByLabel([
      t({ debit: 50_000, matched_to_type: "loan_given" }),
      t({ debit: 30_000, matched_to_type: "bs_item", lent: true }),
    ], "out");
    expect(out).toEqual([{ label: LENDING_LABEL, amount: 80_000, count: 2 }]);
  });

  it("'lent' only counts for bs_item / manual / loan_given lines", () => {
    expect(A("payment", true)).toBe("operating");
    expect(A("transfer", true)).toBe("transfer");
    expect(A(null, true)).toBe("unreconciled");
  });

  it("business loans taken, drawdowns, repayments and EMIs → financing", () => {
    for (const k of ["business_loan", "loan_drawdown", "loan_repayment", "emi"]) expect(A(k)).toBe("financing");
  });

  it("owner drawings / capital stay financing", () => {
    expect(A("owner_equity")).toBe("financing");
  });

  it("staff loans / salary advances are working capital → operating (needsDecision on R-2575)", () => {
    expect(A("employee_loan")).toBe("operating");
  });

  it("the statement's own headings say where loans go", () => {
    expect(ACTIVITY_LABEL.investing).toMatch(/^Investing activities/);
    expect(ACTIVITY_LABEL.investing).toMatch(/loans given/);
    expect(ACTIVITY_LABEL.financing).toMatch(/loans taken/);
  });
});

describe("R-2570 — challans / owed-back money stay operating; new types are named", () => {
  it("names the new types and keeps the operating ones there", async () => {
    const { activityOf, lineLabel } = await import("./cash-flow-lines");
    expect(activityOf({ matched_to_type: "statutory", category: null })).toBe("operating");
    expect(activityOf({ matched_to_type: "reimbursement", category: null })).toBe("operating");
    expect(lineLabel({ matched_to_type: "bs_item", category: null })).toBe("Capital / loans (balance sheet)");
    expect(lineLabel({ matched_to_type: "employee_loan", category: null })).toBe("Staff loans");
  });
});
