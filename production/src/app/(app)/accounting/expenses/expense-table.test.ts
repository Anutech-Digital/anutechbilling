import { describe, it, expect } from "vitest";
import { sortRows } from "@/lib/table/data-table";
import {
  filterExpenses, EXPENSE_SORT, expenseViewState, readExpenseView, type ExpenseListRow,
} from "./expense-table";

const row = (id: string, over: Partial<ExpenseListRow> = {}): ExpenseListRow => ({
  id, expense_date: "2026-10-01", category: "Rent", vendor_name: null, description: null,
  payment_method: "upi", amount: 1000, ...over,
});

const rows: ExpenseListRow[] = [
  row("a", { expense_date: "2026-10-03", amount: 9000, vendor_name: "Anthropic", category: "Software" }),
  row("b", { expense_date: "2026-09-28", amount: 10000, vendor_name: "Landlord", category: "Rent" }),
  row("c", { expense_date: "2026-10-05", amount: 450, vendor_name: null, category: "Office", description: "chai" }),
];

describe("R-213 expenses list — sortable headers", () => {
  it("amount sorts as a number, not text (9,000 below 10,000)", () => {
    expect(sortRows(rows, EXPENSE_SORT.amount, "asc").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(sortRows(rows, EXPENSE_SORT.amount, "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("date sorts oldest/newest first", () => {
    expect(sortRows(rows, EXPENSE_SORT.date, "asc").map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(sortRows(rows, EXPENSE_SORT.date, "desc").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("no vendor goes last in both directions", () => {
    expect(sortRows(rows, EXPENSE_SORT.vendor, "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, EXPENSE_SORT.vendor, "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("R-213 expenses list — filters and row count", () => {
  const none = { payee: "", unpaidOnly: false, search: "" };
  const owes = (e: ExpenseListRow) => e.id !== "b";

  it("no filter keeps every row", () => {
    expect(filterExpenses(rows, none, owes)).toHaveLength(3);
  });

  it("payee is an exact vendor match", () => {
    expect(filterExpenses(rows, { ...none, payee: "Anthropic" }, owes).map((r) => r.id)).toEqual(["a"]);
    expect(filterExpenses(rows, { ...none, payee: "Anthro" }, owes)).toHaveLength(0);
  });

  it("To pay uses the page's own owes rule", () => {
    expect(filterExpenses(rows, { ...none, unpaidOnly: true }, owes).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("search covers category, vendor, note and amount, any case", () => {
    expect(filterExpenses(rows, { ...none, search: "CHAI" }, owes).map((r) => r.id)).toEqual(["c"]);
    expect(filterExpenses(rows, { ...none, search: "landlord" }, owes).map((r) => r.id)).toEqual(["b"]);
    expect(filterExpenses(rows, { ...none, search: "9000" }, owes).map((r) => r.id)).toEqual(["a"]);
    expect(filterExpenses(rows, { ...none, search: "  " }, owes)).toHaveLength(3);
  });

  it("filters combine", () => {
    expect(filterExpenses(rows, { payee: "Landlord", unpaidOnly: true, search: "" }, owes)).toHaveLength(0);
  });
});

describe("R-213 expenses list — saved views", () => {
  const cur = { from: "2026-10-01", to: "2026-10-31", category: "", payee: "", unpaidOnly: false, search: "" };

  it("round-trips every filter", () => {
    const s = { from: "2026-04-01", to: "2027-03-31", category: "Rent", payee: "Landlord", unpaidOnly: true, search: "oct" };
    expect(readExpenseView(expenseViewState(s), cur)).toEqual(s);
  });

  it("a broken saved view falls back instead of blanking the list", () => {
    expect(readExpenseView({ from: "yesterday", to: 5, unpaidOnly: "yes", category: null }, cur)).toEqual(cur);
  });
});
