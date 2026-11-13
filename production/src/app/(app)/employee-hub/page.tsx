"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { BudgetOverviewSection } from "@/components/features/employee-hub/budget-overview-section";
import {
  PersonalExpensesSection,
  type PersonalTransaction,
} from "@/components/features/employee-hub/personal-expenses-section";
import { BankAccountsSection } from "@/components/features/employee-hub/bank-accounts-section";
import { SalariedDocumentVaultSection } from "@/components/features/employee-hub/salaried-document-vault-section";
import { ItrFilingAssistant } from "@/components/features/employee-hub/itr-filing-assistant";
import {
  loadBankAccounts,
  loadBudget,
  loadTransactions,
  saveTransactions,
  type SalariedBankAccount,
  type SalariedBudget,
  STORAGE_EXPENSES_KEY,
} from "@/lib/employee-hub/personal-finance-store";

export type HubTab = "budget" | "expenses" | "banks" | "vault" | "tax";

export default function EmployeeHubPage() {
  return (
    <React.Suspense fallback={<div className="p-6 max-w-7xl mx-auto text-ink-3">Loading Salaried Pro Hub...</div>}>
      <EmployeeHubContent />
    </React.Suspense>
  );
}

function EmployeeHubContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");

  const resolveTab = (param: string | null): HubTab => {
    if (param && ["budget", "expenses", "banks", "vault", "tax"].includes(param)) {
      return param as HubTab;
    }
    if (param === "bank-import") return "banks";
    if (param === "income") return "expenses";
    return "budget";
  };

  const activeTab: HubTab = React.useMemo(() => resolveTab(tabParam), [tabParam]);

  // Financial States
  const [bankAccounts, setBankAccounts] = React.useState<SalariedBankAccount[]>(loadBankAccounts);
  const [budget, setBudget] = React.useState<SalariedBudget>(loadBudget);
  const [transactions, setTransactions] = React.useState<PersonalTransaction[]>(loadTransactions);

  // Sync state from storage events
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const syncData = () => {
        setBankAccounts(loadBankAccounts());
        setBudget(loadBudget());
        setTransactions(loadTransactions());
      };

      window.addEventListener("salaried_pro_expenses_updated", syncData);
      window.addEventListener("salaried_pro_banks_updated", syncData);
      window.addEventListener("salaried_pro_budget_updated", syncData);

      return () => {
        window.removeEventListener("salaried_pro_expenses_updated", syncData);
        window.removeEventListener("salaried_pro_banks_updated", syncData);
        window.removeEventListener("salaried_pro_budget_updated", syncData);
      };
    }
  }, []);

  const handleTabChange = (tab: HubTab) => {
    router.push(`/employee-hub?tab=${tab}`, { scroll: false });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("app:tab-change"));
    }
  };

  // Top Metric Calculations
  const totalBankBalance = React.useMemo(() => {
    return bankAccounts.reduce((sum, a) => sum + a.balanceRupees, 0);
  }, [bankAccounts]);

  const totalIncome = React.useMemo(() => {
    return transactions
      .filter((t) => t.type === "income")
      .reduce((sum, t) => sum + t.amountRupees, 0);
  }, [transactions]);

  const totalSpent = React.useMemo(() => {
    return transactions
      .filter((t) => t.type !== "income")
      .reduce((sum, t) => sum + t.amountRupees, 0);
  }, [transactions]);

  const netSavings = totalIncome - totalSpent;
  const savingsRatePct = totalIncome > 0 ? Math.max(0, Math.round((netSavings / totalIncome) * 100)) : 0;

  const handleTransactionsImported = (newItems: PersonalTransaction[]) => {
    const combined = [...newItems, ...transactions];
    setTransactions(combined);
    saveTransactions(combined);
  };

  const handleOpenAddRecord = () => {
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
            Clean, stress-free money management for salaried individuals: record daily income and expenses manually, set category budgets, and import bank statements with automatic salary &amp; UPI categorization.
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
            onClick={handleOpenAddRecord}
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Icon name="plus" size={14} />
            + Record Entry
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

        {/* Card 2: Total Inflow / Income */}
        <Card
          onClick={() => handleTabChange("expenses")}
          className="p-4 border-2 border-emerald-100 hover:border-emerald-300 transition-all cursor-pointer bg-gradient-to-br from-emerald-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Total Monthly Inflow</span>
            <Icon name="wallet" size={16} className="text-emerald-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-emerald-700 mt-1.5 font-mono">
            {rupee(totalIncome)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {transactions.filter((t) => t.type === "income").length} income credits recorded
          </span>
        </Card>

        {/* Card 3: Monthly Spends */}
        <Card
          onClick={() => handleTabChange("expenses")}
          className="p-4 border-2 border-rose-100 hover:border-rose-300 transition-all cursor-pointer bg-gradient-to-br from-rose-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Total Monthly Spends</span>
            <Icon name="tag" size={16} className="text-rose-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-rose-950 mt-1.5 font-mono">
            {rupee(totalSpent)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {transactions.filter((t) => t.type !== "income").length} expense debits recorded
          </span>
        </Card>

        {/* Card 4: Net Surplus / Savings */}
        <Card
          onClick={() => handleTabChange("budget")}
          className="p-4 border-2 border-amber-100 hover:border-amber-300 transition-all cursor-pointer bg-gradient-to-br from-amber-50/30 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Net Monthly Savings</span>
            <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
              {savingsRatePct}% Saved
            </span>
          </div>
          <div
            className={`text-2xl font-serif font-bold mt-1.5 font-mono ${
              netSavings >= 0 ? "text-ink" : "text-rose-600"
            }`}
          >
            {rupee(netSavings)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {netSavings >= 0 ? "Surplus remaining after all spends" : "Deficit (spends exceeded income)"}
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
          Income &amp; Expenses Ledger ({transactions.length})
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
          expenses={transactions}
          onNavigateToExpenses={() => handleTabChange("expenses")}
          onNavigateToBanks={() => handleTabChange("banks")}
          onAddExpenseClick={handleOpenAddRecord}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 2: INCOME & EXPENSES LEDGER                                      */}
      {/* ==================================================================== */}
      {activeTab === "expenses" && (
        <PersonalExpensesSection
          onNavigateToBankImport={() => handleTabChange("banks")}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 3: BANK ACCOUNTS & STATEMENT IMPORTER                            */}
      {/* ==================================================================== */}
      {activeTab === "banks" && (
        <BankAccountsSection
          onExpensesImported={handleTransactionsImported}
          onNavigateToExpenses={() => handleTabChange("expenses")}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 4: DIGITAL DOCUMENT VAULT (OPTIONAL ADVANCED)                    */}
      {/* ==================================================================== */}
      {activeTab === "vault" && (
        <SalariedDocumentVaultSection onNavigateToItr={() => handleTabChange("tax")} />
      )}

      {/* ==================================================================== */}
      {/* TAB 5: ITR-1 ASSISTANT (OPTIONAL ADVANCED)                           */}
      {/* ==================================================================== */}
      {activeTab === "tax" && (
        <ItrFilingAssistant
          initialSalaryGross={totalIncome > 0 ? totalIncome * 12 : 1020000}
          initialOtherIncome={0}
        />
      )}
    </div>
  );
}
