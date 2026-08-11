import { describe, it, expect } from "vitest";
import { suggestCategory, findDuplicateExpense, splitLinesByCategory, expensePayStatus } from "./expenses";

describe("suggestCategory", () => {
  it("maps common notes to a category", () => {
    expect(suggestCategory("Team lunch with client")).toBe("Business Promotion");
    expect(suggestCategory("Uber to airport")).toBe("Travel");
    expect(suggestCategory("Airtel broadband bill")).toBe("Internet & Phone");
    expect(suggestCategory("Anthropic Claude subscription")).toBe("Software");
    expect(suggestCategory("AWS server hosting")).toBe("Hosting");
    expect(suggestCategory("Office rent July")).toBe("Office Rent");
    expect(suggestCategory("CA audit fees")).toBe("Professional Services");
    expect(suggestCategory("printer toner + paper")).toBe("Office Supplies");
    expect(suggestCategory("electricity bill")).toBe("Utilities");
  });
  it("understands Hinglish / Hindi notes", () => {
    expect(suggestCategory("client ke pass jane ke liye")).toBe("Travel");
    expect(suggestCategory("team ke liye khana")).toBe("Business Promotion");
    expect(suggestCategory("office ka kiraya")).toBe("Office Rent");
    expect(suggestCategory("bijli ka bill")).toBe("Utilities");
    expect(suggestCategory("mobile recharge")).toBe("Internet & Phone");
  });
  it("routes own-team spend to Staff Welfare, not Business Promotion", () => {
    expect(suggestCategory("Birthday cake for Abhishek")).toBe("Staff Welfare");
    expect(suggestCategory("cake")).toBe("Staff Welfare");
    expect(suggestCategory("staff lunch")).toBe("Staff Welfare");
    expect(suggestCategory("Diwali gift to staff")).toBe("Staff Welfare");
    expect(suggestCategory("employee welfare")).toBe("Staff Welfare");
    // plain client-facing food/gift still falls to Business Promotion
    expect(suggestCategory("gift for client")).toBe("Business Promotion");
    expect(suggestCategory("lunch with customer")).toBe("Business Promotion");
  });
  it("returns null when nothing matches (never a wrong guess)", () => {
    expect(suggestCategory("")).toBeNull();
    expect(suggestCategory("miscellaneous thing xyz")).toBeNull();
  });
  it("never guesses Salaries (that's Payroll)", () => {
    expect(suggestCategory("salary for staff")).not.toBe("Salaries");
  });
});

describe("findDuplicateExpense", () => {
  const list = [
    { id: "EXP-1", vendor_id: "v1", vendor_name: "Anthropic, PBC", bill_no: "G06-0014", expense_date: "2026-07-10", amount: 5304, category: "Software" },
    { id: "EXP-2", vendor_id: null, vendor_name: "Chai Point", bill_no: null, expense_date: "2026-08-01", amount: 250, category: "Business Promotion" },
    { id: "EXP-3", vendor_id: "v9", vendor_name: "Amazon", bill_no: "AMZ-77", expense_date: "2026-08-02", amount: 60000, category: "Equipment" },
  ];

  it("flags same vendor + same bill number", () => {
    const dup = findDuplicateExpense({ vendorId: "v1", vendorName: "Anthropic, PBC", billNo: "G06-0014" }, list);
    expect(dup?.id).toBe("EXP-1");
  });
  it("matches vendor by name when no id", () => {
    const dup = findDuplicateExpense({ vendorName: "anthropic, pbc", billNo: "G06-0014" }, list);
    expect(dup?.id).toBe("EXP-1");
  });
  it("falls back to vendor + date + amount when no bill number", () => {
    const dup = findDuplicateExpense({ vendorName: "Chai Point", billDate: "2026-08-01", amountInr: 250 }, list);
    expect(dup?.id).toBe("EXP-2");
  });
  it("does not flag a different bill number", () => {
    expect(findDuplicateExpense({ vendorName: "Anthropic, PBC", billNo: "G06-9999" }, list)).toBeNull();
  });
  it("excludes the row being edited (selfId)", () => {
    expect(findDuplicateExpense({ vendorId: "v1", billNo: "G06-0014" }, list, "EXP-1")).toBeNull();
  });
  it("same bill no. + SAME category = duplicate", () => {
    expect(findDuplicateExpense({ vendorId: "v9", billNo: "AMZ-77", category: "Equipment" }, list)?.id).toBe("EXP-3");
  });
  it("same bill no. + DIFFERENT category = split, not a duplicate", () => {
    expect(findDuplicateExpense({ vendorId: "v9", billNo: "AMZ-77", category: "Office Supplies" }, list)).toBeNull();
  });
});

describe("expensePayStatus", () => {
  const today = "2026-08-08";
  it("paid expense is always 'paid' (due date ignored)", () => {
    expect(expensePayStatus({ paid: true, due_date: null }, today)).toBe("paid");
    expect(expensePayStatus({ paid: true, due_date: "2026-01-01" }, today)).toBe("paid");
  });
  it("unpaid with a future/absent due date is 'due'", () => {
    expect(expensePayStatus({ paid: false, due_date: null }, today)).toBe("due");
    expect(expensePayStatus({ paid: false, due_date: "2026-08-20" }, today)).toBe("due");
    expect(expensePayStatus({ paid: false, due_date: today }, today)).toBe("due"); // due today, not yet overdue
  });
  it("unpaid past its due date is 'overdue'", () => {
    expect(expensePayStatus({ paid: false, due_date: "2026-08-07" }, today)).toBe("overdue");
  });
});

describe("splitLinesByCategory", () => {
  const lines = [
    { name: "Laptop", amount: 55000, category: "Equipment" },
    { name: "Mouse", amount: 1200, category: "Equipment" },
    { name: "A4 paper", amount: 800, category: "Office Supplies" },
  ];

  it("groups lines by category in first-seen order", () => {
    const out = splitLinesByCategory(lines, 0);
    expect(out.map((g) => g.category)).toEqual(["Equipment", "Office Supplies"]);
    expect(out[0].amount).toBe(56200);
    expect(out[0].items).toHaveLength(2);
    expect(out[1].amount).toBe(800);
  });

  it("apportions GST by amount share, last group absorbs remainder (parts = whole)", () => {
    const out = splitLinesByCategory(lines, 1000);
    const gstSum = out.reduce((s, g) => s + g.gst, 0);
    expect(gstSum).toBe(1000);
    expect(out[0].gst).toBeGreaterThan(out[1].gst);
  });

  it("single category → one group (no artificial split)", () => {
    const out = splitLinesByCategory([{ name: "X", amount: 100, category: "Software" }], 18);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "Software", amount: 100, gst: 18 });
  });
});
