"use client";

import {
  type PersonalExpense,
  type PersonalExpenseCategory,
  PERSONAL_EXPENSE_CATEGORIES,
} from "@/components/features/employee-hub/personal-expenses-section";

// ============================================================================
// Types
// ============================================================================

export interface SalariedBankAccount {
  id: string;
  bankName: string;
  accountType: "Salary Account" | "Daily UPI / Savings" | "Emergency Fund";
  accountNumberLast4: string;
  balanceRupees: number; // Stored in whole rupees (Rule 4)
  isPrimarySalary: boolean;
}

export interface SalariedIncome {
  monthlyInHand: number;
  salaryDayOfMonth: number;
  employerName: string;
  otherMonthlyIncome: number;
}

export interface SalariedBudget {
  monthlyTargetBudget: number;
  categoryBudgets: Record<PersonalExpenseCategory, number>;
}

// ============================================================================
// Storage Keys
// ============================================================================

export const STORAGE_EXPENSES_KEY = "salaried_pro_personal_expenses_v1";
export const STORAGE_BANKS_KEY = "salaried_pro_bank_accounts_v1";
export const STORAGE_INCOME_KEY = "salaried_pro_income_v1";
export const STORAGE_BUDGET_KEY = "salaried_pro_budget_v1";

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_BANK_ACCOUNTS: SalariedBankAccount[] = [
  {
    id: "acc-hdfc",
    bankName: "HDFC Bank",
    accountType: "Salary Account",
    accountNumberLast4: "4892",
    balanceRupees: 118500,
    isPrimarySalary: true,
  },
  {
    id: "acc-sbi",
    bankName: "State Bank of India (SBI)",
    accountType: "Daily UPI / Savings",
    accountNumberLast4: "1104",
    balanceRupees: 14200,
    isPrimarySalary: false,
  },
  {
    id: "acc-icici",
    bankName: "ICICI Bank",
    accountType: "Emergency Fund",
    accountNumberLast4: "7721",
    balanceRupees: 50000,
    isPrimarySalary: false,
  },
];

export const DEFAULT_INCOME: SalariedIncome = {
  monthlyInHand: 85000,
  salaryDayOfMonth: 1,
  employerName: "Anutech Digital Pvt Ltd",
  otherMonthlyIncome: 2500,
};

export const DEFAULT_CATEGORY_BUDGETS: Record<PersonalExpenseCategory, number> = {
  "Housing & Rent": 22000,
  "Food & Groceries": 12000,
  "Utilities & Bills": 5000,
  "Fuel & Commute": 4000,
  "Shopping & Lifestyle": 5000,
  "Subscriptions & OTT": 1500,
  "Health & Medical": 2500,
  "EMI & Loans": 0,
  "Entertainment & Dining": 3000,
  "Miscellaneous": 2000,
};

export const DEFAULT_BUDGET: SalariedBudget = {
  monthlyTargetBudget: 57000,
  categoryBudgets: DEFAULT_CATEGORY_BUDGETS,
};

// ============================================================================
// Persistence Helpers
// ============================================================================

export function loadBankAccounts(): SalariedBankAccount[] {
  if (typeof window === "undefined") return DEFAULT_BANK_ACCOUNTS;
  try {
    const raw = localStorage.getItem(STORAGE_BANKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // fallback
  }
  return DEFAULT_BANK_ACCOUNTS;
}

export function saveBankAccounts(accounts: SalariedBankAccount[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_BANKS_KEY, JSON.stringify(accounts));
    window.dispatchEvent(new Event("salaried_pro_banks_updated"));
  } catch {
    // ignore
  }
}

export function loadIncome(): SalariedIncome {
  if (typeof window === "undefined") return DEFAULT_INCOME;
  try {
    const raw = localStorage.getItem(STORAGE_INCOME_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return DEFAULT_INCOME;
}

export function saveIncome(income: SalariedIncome): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_INCOME_KEY, JSON.stringify(income));
    window.dispatchEvent(new Event("salaried_pro_income_updated"));
  } catch {
    // ignore
  }
}

export function loadBudget(): SalariedBudget {
  if (typeof window === "undefined") return DEFAULT_BUDGET;
  try {
    const raw = localStorage.getItem(STORAGE_BUDGET_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return DEFAULT_BUDGET;
}

export function saveBudget(budget: SalariedBudget): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_BUDGET_KEY, JSON.stringify(budget));
    window.dispatchEvent(new Event("salaried_pro_budget_updated"));
  } catch {
    // ignore
  }
}
