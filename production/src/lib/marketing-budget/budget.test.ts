import { describe, expect, it } from "vitest";
import {
  budgetLeft, budgetPaid, canApproveBudget, canAskBudget, canPay, expenseFor, monthStart, paymentProblem,
} from "./budget";

describe("budgetLeft — what billing may still pay", () => {
  const pays = [
    { amount: 30000, status: "paid" },
    { amount: 5000, status: "pending" },
    { amount: 9000, status: "rejected" },
    { amount: 2000, status: "cancelled" },
  ];
  it("approved minus paid and still-asked, ignoring rejected / cancelled", () => {
    expect(budgetLeft(50000, pays)).toBe(15000);
    expect(budgetPaid(pays)).toBe(30000);
  });
  it("nothing approved → nothing left; never negative", () => {
    expect(budgetLeft(null, pays)).toBe(0);
    expect(budgetLeft(10000, pays)).toBe(0);
  });
});

describe("paymentProblem", () => {
  it("refuses over the budget with the amount left", () => {
    expect(paymentProblem(16000, 15000, "approved")).toBe("Only ₹15,000 is left on this budget — ask the owner for more budget.");
  });
  it("refuses against a budget that is not approved", () => {
    expect(paymentProblem(100, 1000, "pending")).toMatch(/not approved/);
  });
  it("accepts within the budget", () => {
    expect(paymentProblem(15000, 15000, "approved")).toBeNull();
  });
});

describe("who may do what (Abhishek, 23 Oct)", () => {
  it("marketing and owner ask; only the owner approves; billing / owner / accountant pay", () => {
    expect(canAskBudget("marketing")).toBe(true);
    expect(canAskBudget("billing")).toBe(false);
    expect(canApproveBudget("owner")).toBe(true);
    expect(canApproveBudget("manager")).toBe(false);
    expect(canApproveBudget("billing")).toBe(false);
    expect(canPay("billing")).toBe(true);
    expect(canPay("marketing")).toBe(false);
  });
});

describe("expenseFor — a paid request shows in Marketing spend", () => {
  it("ads are Advertising with their channel", () => {
    expect(expenseFor({ channel: "google-ads", product_name: "Google Workspace" }, { pay_to: "Google Ads", purpose: "Nov search" }))
      .toEqual({ category: "Advertising", channel: "google-ads", vendor_name: "Google Ads", description: "Marketing budget payment — Google Ads · Google Workspace · Nov search" });
  });
  it("events are Marketing; 'other' has no channel", () => {
    expect(expenseFor({ channel: "trade-show", product_name: null }, { pay_to: "Expo Ltd", purpose: null }).category).toBe("Marketing");
    expect(expenseFor({ channel: "other", product_name: null }, { pay_to: "Printer", purpose: null }).channel).toBeNull();
  });
});

describe("monthStart", () => {
  it("reads YYYY-MM", () => {
    expect(monthStart("2026-11")?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthStart("2026-13")).toBeNull();
  });
});
