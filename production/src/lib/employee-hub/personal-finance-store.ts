"use client";

// ============================================================================
// Types
// ============================================================================

export type TransactionType = "expense" | "income";

export type PersonalExpenseCategory =
  | "Housing & Rent"
  | "Food & Groceries"
  | "Utilities & Bills"
  | "Fuel & Commute"
  | "Shopping & Lifestyle"
  | "Subscriptions & OTT"
  | "Health & Medical"
  | "EMI & Loans"
  | "Entertainment & Dining"
  | "Miscellaneous";

export type PersonalIncomeCategory =
  | "Salary"
  | "Bonus / Incentive"
  | "Freelance / Side Gig"
  | "Interest & Dividends"
  | "Refund & Cashback"
  | "Rental Income"
  | "Other Income";

export interface PersonalTransaction {
  id: string;
  type: TransactionType; // "expense" | "income"
  date: string; // YYYY-MM-DD
  category: PersonalExpenseCategory | PersonalIncomeCategory | string;
  description: string;
  amountRupees: number; // Stored in whole rupees (Rule 4)
  paymentMode: "UPI" | "Credit Card" | "Debit Card" | "Net Banking" | "Cash";
  bankAccountId?: string;
  tags?: string[];
}

// Backwards-compatible alias for existing code
export type PersonalExpense = PersonalTransaction;

export interface SalariedBankAccount {
  id: string;
  bankName: string;
  accountType: "Salary Account" | "Daily UPI / Savings" | "Emergency Fund";
  accountNumberLast4: string;
  balanceRupees: number; // Stored in whole rupees (Rule 4)
  isPrimarySalary: boolean;
}

export interface SalariedBudget {
  monthlyTargetBudget: number;
  categoryBudgets: Record<PersonalExpenseCategory, number>;
}

// ============================================================================
// Categories Metadata
// ============================================================================

export const PERSONAL_EXPENSE_CATEGORIES: {
  category: PersonalExpenseCategory;
  icon: string;
  color: string;
}[] = [
  { category: "Housing & Rent", icon: "home", color: "#6366F1" },
  { category: "Food & Groceries", icon: "shopping-bag", color: "#10B981" },
  { category: "Utilities & Bills", icon: "zap", color: "#F59E0B" },
  { category: "Fuel & Commute", icon: "truck", color: "#EC4899" },
  { category: "Shopping & Lifestyle", icon: "tag", color: "#8B5CF6" },
  { category: "Subscriptions & OTT", icon: "play", color: "#06B6D4" },
  { category: "Health & Medical", icon: "heart", color: "#EF4444" },
  { category: "EMI & Loans", icon: "credit-card", color: "#64748B" },
  { category: "Entertainment & Dining", icon: "coffee", color: "#F97316" },
  { category: "Miscellaneous", icon: "more-horizontal", color: "#94A3B8" },
];

export const PERSONAL_INCOME_CATEGORIES: {
  category: PersonalIncomeCategory;
  icon: string;
  color: string;
}[] = [
  { category: "Salary", icon: "wallet", color: "#10B981" },
  { category: "Bonus / Incentive", icon: "gift", color: "#6366F1" },
  { category: "Freelance / Side Gig", icon: "laptop", color: "#06B6D4" },
  { category: "Interest & Dividends", icon: "trending-up", color: "#8B5CF6" },
  { category: "Refund & Cashback", icon: "refresh-cw", color: "#F59E0B" },
  { category: "Rental Income", icon: "home", color: "#14B8A6" },
  { category: "Other Income", icon: "plus-circle", color: "#64748B" },
];

// ============================================================================
// Storage Keys
// ============================================================================

export const STORAGE_EXPENSES_KEY = "salaried_pro_personal_expenses_v1";
export const STORAGE_BANKS_KEY = "salaried_pro_bank_accounts_v1";
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

export const DEFAULT_PERSONAL_TRANSACTIONS: PersonalTransaction[] = [
  {
    id: "tx-income-1",
    type: "income",
    date: "2026-11-01",
    category: "Salary",
    description: "Monthly In-Hand Salary Credit (NEFT CR-ANUTECH DIGITAL)",
    amountRupees: 85000,
    paymentMode: "Net Banking",
    bankAccountId: "acc-hdfc",
    tags: ["Salary", "Primary"],
  },
  {
    id: "tx-exp-1",
    type: "expense",
    date: "2026-11-01",
    category: "Housing & Rent",
    description: "Monthly Apartment Rent (Landlord Transfer)",
    amountRupees: 22000,
    paymentMode: "Net Banking",
    bankAccountId: "acc-hdfc",
  },
  {
    id: "tx-exp-2",
    type: "expense",
    date: "2026-11-03",
    category: "Food & Groceries",
    description: "Monthly Household Groceries at DMart",
    amountRupees: 6450,
    paymentMode: "UPI",
    bankAccountId: "acc-sbi",
  },
  {
    id: "tx-exp-3",
    type: "expense",
    date: "2026-11-04",
    category: "Utilities & Bills",
    description: "Electricity Bill (State Discom) + LPG Refill",
    amountRupees: 2180,
    paymentMode: "UPI",
    bankAccountId: "acc-sbi",
  },
  {
    id: "tx-exp-4",
    type: "expense",
    date: "2026-11-06",
    category: "Fuel & Commute",
    description: "HPCL Petrol Pump Fuel Refill for Car",
    amountRupees: 3500,
    paymentMode: "Credit Card",
    bankAccountId: "acc-hdfc",
  },
  {
    id: "tx-exp-5",
    type: "expense",
    date: "2026-11-08",
    category: "Subscriptions & OTT",
    description: "Netflix Premium + Spotify Annual Sub",
    amountRupees: 949,
    paymentMode: "Credit Card",
    bankAccountId: "acc-hdfc",
  },
  {
    id: "tx-exp-6",
    type: "expense",
    date: "2026-11-10",
    category: "Entertainment & Dining",
    description: "Weekend Dinner & Swiggy Food Orders",
    amountRupees: 1840,
    paymentMode: "UPI",
    bankAccountId: "acc-sbi",
  },
];

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

export function loadTransactions(): PersonalTransaction[] {
  if (typeof window === "undefined") return DEFAULT_PERSONAL_TRANSACTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_EXPENSES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Backfill type = "expense" if missing from legacy records
        return parsed.map((item) => ({
          ...item,
          type: item.type || (item.category === "Salary" || item.category === "Salary Income" ? "income" : "expense"),
        }));
      }
    }
  } catch {
    // fallback
  }
  return DEFAULT_PERSONAL_TRANSACTIONS;
}

export function saveTransactions(txns: PersonalTransaction[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_EXPENSES_KEY, JSON.stringify(txns));
    window.dispatchEvent(new Event("salaried_pro_expenses_updated"));
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
