import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetProblem, budgetToSave } from "./tool-budget";

describe("budgetProblem (R-472)", () => {
  it("refuses a negative budget with a reason", () => {
    expect(budgetProblem("-5000")).toMatch(/cannot be below ₹0/);
  });
  it("refuses paise and text", () => {
    expect(budgetProblem("100.5")).toMatch(/whole rupees/);
    expect(budgetProblem("abc")).toMatch(/in rupees/);
  });
  it("accepts blank, zero and whole rupees", () => {
    expect(budgetProblem("")).toBeNull();
    expect(budgetProblem("0")).toBeNull();
    expect(budgetProblem("5000")).toBeNull();
    expect(budgetToSave("")).toBe(0);
    expect(budgetToSave(" 5000 ")).toBe(5000);
  });
  it("the Marketing Hub dialog uses it and blocks Save", () => {
    const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "marketing", "page.tsx"), "utf8");
    expect(page).toMatch(/budgetProblem\(budget\)/);
    expect(page).toMatch(/disabled=\{save\.isPending \|\| urlBad \|\| !!budgetErr\}/);
    expect(page).not.toMatch(/monthly_budget: Number\(budget\) \|\| 0/);
  });
});
