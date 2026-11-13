"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { toast } from "sonner";
import { BudgetOverviewSection } from "@/components/features/employee-hub/budget-overview-section";
import {
  PersonalExpensesSection,
  type PersonalExpense,
} from "@/components/features/employee-hub/personal-expenses-section";
import { BankAccountsSection } from "@/components/features/employee-hub/bank-accounts-section";
import { SalaryIncomeSetupSection } from "@/components/features/employee-hub/salary-income-setup-section";
import { SalariedDocumentVaultSection } from "@/components/features/employee-hub/salaried-document-vault-section";
import { ItrFilingAssistant } from "@/components/features/employee-hub/itr-filing-assistant";
import {
  loadBankAccounts,
  loadIncome,
  loadBudget,
  type SalariedBankAccount,
  type SalariedIncome,
  type SalariedBudget,
  STORAGE_EXPENSES_KEY,
} from "@/lib/employee-hub/personal-finance-store";

export type HubTab = "budget" | "expenses" | "banks" | "income" | "vault" | "tax";

export default function EmployeeHubPage() {
  const [activeTab, setActiveTab] = React.useState<HubTab>("budget");

  // Financial States
  const [bankAccounts, setBankAccounts] = React.useState<SalariedBankAccount[]>(loadBankAccounts);
  const [income, setIncome] = React.useState<SalariedIncome>(loadIncome);
  const [budget, setBudget] = React.useState<SalariedBudget>(loadBudget);
  const [expenses, setExpenses] = React.useState<PersonalExpense[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(STORAGE_EXPENSES_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });

  // Sync state from URL and storage events
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const syncTabFromUrl = () => {
        const params = new URLSearchParams(window.location.search);
        const tabParam = params.get("tab");
        if (tabParam && ["budget", "expenses", "banks", "income", "vault", "tax"].includes(tabParam)) {
          setActiveTab(tabParam as HubTab);
        } else if (tabParam === "bank-import") {
          setActiveTab("banks");
        }
      };

      const syncData = () => {
        setBankAccounts(loadBankAccounts());
        setIncome(loadIncome());
        setBudget(loadBudget());
        try {
          const stored = localStorage.getItem(STORAGE_EXPENSES_KEY);
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) setExpenses(parsed);
          }
        } catch {
          // ignore
        }
      };

      syncTabFromUrl();
      window.addEventListener("popstate", syncTabFromUrl);
      window.addEventListener("salaried_pro_expenses_updated", syncData);
      window.addEventListener("salaried_pro_banks_updated", syncData);
      window.addEventListener("salaried_pro_income_updated", syncData);
      window.addEventListener("salaried_pro_budget_updated", syncData);

      return () => {
        window.removeEventListener("popstate", syncTabFromUrl);
        window.removeEventListener("salaried_pro_expenses_updated", syncData);
        window.removeEventListener("salaried_pro_banks_updated", syncData);
        window.removeEventListener("salaried_pro_income_updated", syncData);
        window.removeEventListener("salaried_pro_budget_updated", syncData);
      };
    }
  }, []);

  const handleTabChange = (tab: HubTab) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", url.toString());
      window.dispatchEvent(new Event("app:tab-change"));
    }
  };

  // Top Metric Calculations
  const totalBankBalance = React.useMemo(() => {
    return bankAccounts.reduce((sum, a) => sum + a.balanceRupees, 0);
  }, [bankAccounts]);

  const totalSpent = React.useMemo(() => {
    return expenses.reduce((sum, e) => sum + e.amountRupees, 0);
  }, [expenses]);

  const monthlyTotalIncome = income.monthlyInHand + income.otherMonthlyIncome;
  const remainingBudget = Math.max(0, budget.monthlyTargetBudget - totalSpent);
  const isOverBudget = totalSpent > budget.monthlyTargetBudget;

  const handleExpensesImported = (newItems: PersonalExpense[]) => {
    const updated = [...newItems, ...expenses];
    setExpenses(updated);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_EXPENSES_KEY, JSON.stringify(updated));
        window.dispatchEvent(new Event("salaried_pro_expenses_updated"));
      } catch {
        // ignore
      }
    }
  };

  const handleOpenAddExpense = () => {
    setActiveTab("expenses");
    if (typeof window !== "undefined") {
      setTimeout(() => {
        window.dispatchEvent(new Event("salaried_pro_open_add_expense"));
      }, 50);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-hairline">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-3xl font-semibold text-ink">Salaried Pro</h1>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
              Personal Finance &amp; Budget Manager
            </Badge>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              Free Forever Tier
            </Badge>
          </div>
          <p className="text-sm text-ink-3 mt-1.5 max-w-3xl">
            Clean, stress-free money management for job holders: track your salary in-hand, manage daily expenses, set category budgets, and import bank statements with automatic UPI categorization.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/settings/modules">
            <Button variant="outline" size="sm" className="gap-2">
              <Icon name="package" size={14} />
              Modular Plugins
            </Button>
          </Link>
          <Button
            variant="primary"
            size="sm"
            onClick={handleOpenAddExpense}
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Icon name="plus" size={14} />
            + Record Expense
          </Button>
        </div>
      </div>

      {/* Top 4 KPI Financial Cockpit */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Bank Balance */}
        <Card
          onClick={() => handleTabChange("banks")}
          className="p-4 border-2 border-indigo-100 hover:border-indigo-300 transition-all cursor-pointer bg-gradient-to-br from-indigo-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Total Bank Balance</span>
            <Icon name="building" size={16} className="text-indigo-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-indigo-950 mt-1.5 font-mono">
            {rupee(totalBankBalance)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            Across {bankAccounts.length} connected accounts • Click to view
          </span>
        </Card>

        {/* Card 2: Monthly In-Hand Income */}
        <Card
          onClick={() => handleTabChange("income")}
          className="p-4 border-2 border-emerald-100 hover:border-emerald-300 transition-all cursor-pointer bg-gradient-to-br from-emerald-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Monthly In-Hand</span>
            <Icon name="wallet" size={16} className="text-emerald-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-emerald-700 mt-1.5 font-mono">
            {rupee(monthlyTotalIncome)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {income.employerName} • Day {income.salaryDayOfMonth}
          </span>
        </Card>

        {/* Card 3: Monthly Spends */}
        <Card
          onClick={() => handleTabChange("expenses")}
          className="p-4 border-2 border-rose-100 hover:border-rose-300 transition-all cursor-pointer bg-gradient-to-br from-rose-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Total Spends This Month</span>
            <Icon name="tag" size={16} className="text-rose-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-rose-950 mt-1.5 font-mono">
            {rupee(totalSpent)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {expenses.length} transactions recorded
          </span>
        </Card>

        {/* Card 4: Remaining Budget */}
        <Card
          onClick={() => handleTabChange("budget")}
          className={`p-4 border-2 transition-all cursor-pointer bg-gradient-to-br from-paper to-paper ${
            isOverBudget
              ? "border-rose-200 bg-rose-50/20"
              : "border-amber-100 hover:border-amber-300 bg-amber-50/30"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Remaining Budget</span>
            <span
              className={`text-2xs font-semibold px-2 py-0.5 rounded ${
                isOverBudget
                  ? "bg-rose-100 text-rose-800"
                  : "bg-emerald-100 text-emerald-800"
              }`}
            >
              {isOverBudget ? "Over Budget" : "On Track"}
            </span>
          </div>
          <div
            className={`text-2xl font-serif font-bold mt-1.5 font-mono ${
              isOverBudget ? "text-rose-600" : "text-ink"
            }`}
          >
            {isOverBudget ? rupee(totalSpent - budget.monthlyTargetBudget) : rupee(remainingBudget)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {isOverBudget ? "Exceeded target cap" : `of ${rupee(budget.monthlyTargetBudget)} monthly cap`}
          </span>
        </Card>
      </div>

      {/* Primary Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-hairline pb-2 overflow-x-auto">
        <button
          onClick={() => handleTabChange("budget")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "budget"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="pie_chart" size={16} />
          Budget &amp; Overview
        </button>

        <button
          onClick={() => handleTabChange("expenses")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "expenses"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="tag" size={16} />
          Daily Expenses ({expenses.length})
        </button>

        <button
          onClick={() => handleTabChange("banks")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "banks"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="building" size={16} />
          Bank Accounts &amp; Statement Import
        </button>

        <button
          onClick={() => handleTabChange("income")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "income"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="wallet" size={16} />
          Salary &amp; Income Setup
        </button>

        <span className="text-ink-3 mx-1">|</span>

        <button
          onClick={() => handleTabChange("vault")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeTab === "vault"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-3 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="file" size={14} />
          Document Vault
        </button>

        <button
          onClick={() => handleTabChange("tax")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeTab === "tax"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-3 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="rupee" size={14} />
          ITR-1 Assistant
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: BUDGET & OVERVIEW                                             */}
      {/* ==================================================================== */}
      {activeTab === "budget" && (
        <BudgetOverviewSection
          expenses={expenses}
          onNavigateToExpenses={() => handleTabChange("expenses")}
          onNavigateToBanks={() => handleTabChange("banks")}
          onAddExpenseClick={handleOpenAddExpense}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 2: DAILY EXPENSES LEDGER                                         */}
      {/* ==================================================================== */}
      {activeTab === "expenses" && (
        <PersonalExpensesSection
          monthlySalaryRupees={monthlyTotalIncome}
          onNavigateToBankImport={() => handleTabChange("banks")}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 3: BANK ACCOUNTS & STATEMENT IMPORTER                            */}
      {/* ==================================================================== */}
      {activeTab === "banks" && (
        <BankAccountsSection
          onExpensesImported={handleExpensesImported}
          onNavigateToExpenses={() => handleTabChange("expenses")}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 4: SALARY & INCOME SETUP                                         */}
      {/* ==================================================================== */}
      {activeTab === "income" && (
        <SalaryIncomeSetupSection
          onIncomeSaved={(inc) => setIncome(inc)}
          onNavigateToOverview={() => handleTabChange("budget")}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 5: DIGITAL DOCUMENT VAULT (OPTIONAL ADVANCED)                    */}
      {/* ==================================================================== */}
      {activeTab === "vault" && (
        <SalariedDocumentVaultSection onNavigateToItr={() => handleTabChange("tax")} />
      )}

      {/* ==================================================================== */}
      {/* TAB 6: ITR-1 ASSISTANT (OPTIONAL ADVANCED)                           */}
      {/* ==================================================================== */}
      {activeTab === "tax" && (
        <ItrFilingAssistant
          initialSalaryGross={income.monthlyInHand * 12}
          initialOtherIncome={income.otherMonthlyIncome * 12}
        />
      )}
    </div>
  );
}
