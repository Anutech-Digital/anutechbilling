// R-2387 — the Income & Expenses arithmetic: sources, ITR heads, Saved, month filter, monthly
// repeats and the CSV. Owner's own example first (card howToCheck): Rent ₹20,000 → Income tile,
// ITR head House property; then an expense → Saved = Income − Spend.
import { describe, it, expect } from "vitest";
import {
  INCOME_SOURCES,
  EXPENSE_FORM_CATEGORIES,
  summariseIncomeExpense,
  sourceOf,
  headOf,
  kindForSource,
  fyMonths,
  inPeriod,
  monthlyDue,
  csvRows,
  rowLabel,
  type LedgerRow,
} from "./income-expense";
import { PERSONAL_SPEND_CATEGORIES } from "./categories";

const r = (over: Partial<LedgerRow>): LedgerRow => ({ kind: "expense", amount: 100, occurred_on: "2026-10-05", ...over });

describe("owner's path: rent ₹20,000 then an expense", () => {
  it("rent lands in Income under House property; Saved = Income − Spend", () => {
    const rows = [
      r({ kind: kindForSource("rent"), income_source: "rent", amount: 20_000 }),
      r({ kind: "expense", category: "Household", amount: 7_500 }),
    ];
    const s = summariseIncomeExpense(rows);
    expect(s.income).toBe(20_000);
    expect(s.spent).toBe(7_500);
    expect(s.saved).toBe(12_500);
    expect(s.bySource).toEqual([{ source: "rent", label: "Rent (house property)", total: 20_000, count: 1 }]);
    expect(s.byHead).toEqual([{ head: "house_property", label: "House property", total: 20_000 }]);
  });
});

describe("sources and ITR heads", () => {
  it("has the owner's ten sources in order", () => {
    expect(INCOME_SOURCES.map((s) => s.label)).toEqual([
      "Salary", "Rent (house property)", "Interest", "Dividend", "Business / freelance",
      "Agriculture", "Capital gains", "Gift", "Refund", "Other",
    ]);
  });

  it("maps each source to the kind the DB CHECK expects", () => {
    expect(kindForSource("salary")).toBe("salary");
    expect(kindForSource("interest")).toBe("interest");
    expect(kindForSource("dividend")).toBe("dividend");
    expect(kindForSource("refund")).toBe("refund");
    for (const s of ["rent", "business", "agriculture", "capital_gains", "gift", "other"] as const) {
      expect(kindForSource(s)).toBe("other_income");
    }
  });

  it("maps heads: business, capital gains, agriculture exempt, gift other sources, drawing apart", () => {
    expect(headOf("business")).toBe("business");
    expect(headOf("capital_gains")).toBe("capital_gains");
    expect(headOf("agriculture")).toBe("exempt");
    expect(headOf("refund")).toBe("exempt");
    expect(headOf("gift")).toBe("other_sources");
    expect(headOf("salary")).toBe("salary");
    expect(headOf("drawing")).toBe("from_company");
  });

  it("an old row with no income_source takes its kind as the source", () => {
    expect(sourceOf({ kind: "salary", income_source: null })).toBe("salary");
    expect(sourceOf({ kind: "other_income", income_source: null })).toBe("other");
    expect(sourceOf({ kind: "drawing", income_source: null })).toBe("drawing");
    expect(sourceOf({ kind: "expense", income_source: null })).toBeNull();
  });
});

describe("what counts", () => {
  it("transfers, card payments and ATM cash are neither income nor spend", () => {
    const s = summariseIncomeExpense([
      r({ kind: "transfer_in", amount: 5_000 }),
      r({ kind: "transfer_out", amount: 5_000 }),
      r({ kind: "card_payment", amount: 9_000 }),
      r({ kind: "atm_cash", amount: 2_000 }),
      r({ kind: "salary", income_source: "salary", amount: 90_000 }),
    ]);
    expect(s.income).toBe(90_000);
    expect(s.spent).toBe(0);
    expect(s.byCategory).toEqual([]);
  });

  it("a drawing is income (from company) and shows on its own head", () => {
    const s = summariseIncomeExpense([r({ kind: "drawing", amount: 3_00_000 }), r({ kind: "dividend", amount: 1_00_000 })]);
    expect(s.income).toBe(4_00_000);
    expect(s.byHead.map((h) => h.head)).toEqual(["other_sources", "from_company"]);
  });

  it("ranks spending categories by amount; blank category = Uncategorised", () => {
    const s = summariseIncomeExpense([
      r({ category: "Groceries", amount: 400 }),
      r({ category: "Medical", amount: 900 }),
      r({ category: "  ", amount: 50 }),
    ]);
    expect(s.byCategory.map((c) => c.category)).toEqual(["Medical", "Groceries", "Uncategorised"]);
  });

  it("ignores zero / negative amounts", () => {
    expect(summariseIncomeExpense([r({ amount: 0 }), r({ amount: -5 })]).spent).toBe(0);
  });
});

describe("periods", () => {
  it("FY months run April to March", () => {
    const m = fyMonths("2026-04-01");
    expect(m[0]).toBe("2026-04");
    expect(m[11]).toBe("2027-03");
    expect(m).toHaveLength(12);
  });

  it("month filter keeps only that month of the FY", () => {
    const rows = [r({ occurred_on: "2026-03-31" }), r({ occurred_on: "2026-04-01" }), r({ occurred_on: "2026-10-05" }), r({ occurred_on: "2027-04-01" })];
    expect(inPeriod(rows, "2026-04-01", null).map((x) => x.occurred_on)).toEqual(["2026-04-01", "2026-10-05"]);
    expect(inPeriod(rows, "2026-04-01", "2026-10").map((x) => x.occurred_on)).toEqual(["2026-10-05"]);
  });
});

describe("repeat monthly (no cron)", () => {
  const salary = r({ id: "s1", kind: "salary", income_source: "salary", party: "Acme", amount: 90_000, occurred_on: "2026-10-31", repeat_monthly: true });

  it("offers this month's salary when only last month's exists, same day clamped", () => {
    const due = monthlyDue([salary], "2026-11");
    expect(due).toHaveLength(1);
    expect(due[0].date).toBe("2026-11-30");
    expect(due[0].label).toBe("Salary · Acme");
  });

  it("says nothing once this month's entry is added", () => {
    const nov = { ...salary, id: "s2", occurred_on: "2026-11-30" };
    expect(monthlyDue([salary, nov], "2026-11")).toEqual([]);
  });

  it("stops when the newest entry of the series is no longer monthly", () => {
    const stopped = { ...salary, id: "s0", occurred_on: "2026-10-31", repeat_monthly: false };
    expect(monthlyDue([{ ...salary, occurred_on: "2026-09-30" }, stopped], "2026-11")).toEqual([]);
  });

  it("different parties are different series", () => {
    const rent = r({ id: "r1", kind: "other_income", income_source: "rent", party: "Tenant A", amount: 20_000, occurred_on: "2026-10-05", repeat_monthly: true });
    expect(monthlyDue([salary, rent], "2026-11").map((d) => d.label)).toEqual(["Rent (house property) · Tenant A", "Salary · Acme"]);
  });
});

describe("expense categories and CSV", () => {
  it("the form keeps every shared spending category and adds Loan EMI", () => {
    for (const c of PERSONAL_SPEND_CATEGORIES) expect(EXPENSE_FORM_CATEGORIES).toContain(c);
    expect(EXPENSE_FORM_CATEGORIES).toContain("Loan EMI");
  });

  it("CSV: income positive with its ITR head, expense negative, cash when no account", () => {
    const rows = csvRows([
      r({ kind: "other_income", income_source: "rent", amount: 20_000, account_id: "a1", party: "Tenant" }),
      r({ kind: "expense", category: "Medical", amount: 1_500 }),
    ], (id) => (id === "a1" ? "HDFC" : undefined));
    expect(rows[0]).toEqual(["2026-10-05", "Income", "Rent (house property)", "House property", 20_000, "HDFC", "Tenant", ""]);
    expect(rows[1]).toEqual(["2026-10-05", "Expense", "Medical", "", -1_500, "Cash", "", ""]);
  });

  it("row label: source for income, kind for transfers", () => {
    expect(rowLabel({ kind: "other_income", income_source: "gift" })).toBe("Gift");
    expect(rowLabel({ kind: "transfer_in", income_source: null })).toBe("Transfer in");
  });
});
