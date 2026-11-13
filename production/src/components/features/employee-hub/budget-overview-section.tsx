"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { rupee } from "@/lib/utils";
import {
  type PersonalTransaction,
  type PersonalExpenseCategory,
  PERSONAL_EXPENSE_CATEGORIES,
  type SalariedBudget,
  loadBudget,
  saveBudget,
} from "@/lib/employee-hub/personal-finance-store";
import { toast } from "sonner";

interface Props {
  expenses: PersonalTransaction[];
  onNavigateToExpenses: () => void;
  onNavigateToBanks: () => void;
  onAddExpenseClick: () => void;
}

export function BudgetOverviewSection({
  expenses,
  onNavigateToExpenses,
  onNavigateToBanks,
  onAddExpenseClick,
}: Props) {
  const [budget, setBudget] = React.useState<SalariedBudget>(loadBudget);
  const [editBudgetOpen, setEditBudgetOpen] = React.useState(false);
  const [tempBudgetAmount, setTempBudgetAmount] = React.useState<number>(budget.monthlyTargetBudget);
  const [tempCatBudgets, setTempCatBudgets] = React.useState<Record<PersonalExpenseCategory, number>>(
    budget.categoryBudgets
  );

  // Sync when budget updates
  React.useEffect(() => {
    const handler = () => setBudget(loadBudget());
    window.addEventListener("salaried_pro_budget_updated", handler);
    return () => window.removeEventListener("salaried_pro_budget_updated", handler);
  }, []);

  // Compute spend totals (only debits / expenses, not income credits)
  const totalSpent = React.useMemo(() => {
    return expenses
      .filter((e) => e.type !== "income")
      .reduce((sum, e) => sum + e.amountRupees, 0);
  }, [expenses]);

  // Compute income totals from ledger credits
  const totalIncome = React.useMemo(() => {
    return expenses
      .filter((e) => e.type === "income")
      .reduce((sum, e) => sum + e.amountRupees, 0);
  }, [expenses]);

  const targetBudget = budget.monthlyTargetBudget;
  const remainingBudget = Math.max(0, targetBudget - totalSpent);
  const budgetSpentPct = targetBudget > 0 ? Math.min(100, Math.round((totalSpent / targetBudget) * 100)) : 0;
  const isOverBudget = totalSpent > targetBudget;
  const isNearLimit = !isOverBudget && budgetSpentPct >= 85;

  // Category breakdown for expenses
  const categorySpends = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const exp of expenses) {
      if (exp.type !== "income") {
        map[exp.category] = (map[exp.category] || 0) + exp.amountRupees;
      }
    }
    return map;
  }, [expenses]);

  // 50-30-20 Rule calculation
  const rule503020 = React.useMemo(() => {
    let needs = 0;
    let wants = 0;

    for (const exp of expenses) {
      if (exp.type === "income") continue;

      if (
        exp.category === "Housing & Rent" ||
        exp.category === "Food & Groceries" ||
        exp.category === "Utilities & Bills" ||
        exp.category === "Fuel & Commute" ||
        exp.category === "Health & Medical" ||
        exp.category === "EMI & Loans"
      ) {
        needs += exp.amountRupees;
      } else {
        wants += exp.amountRupees;
      }
    }

    const effectiveIncome = totalIncome > 0 ? totalIncome : (targetBudget || 85000);
    const needsPct = effectiveIncome > 0 ? Math.round((needs / effectiveIncome) * 100) : 0;
    const wantsPct = effectiveIncome > 0 ? Math.round((wants / effectiveIncome) * 100) : 0;
    const savings = Math.max(0, effectiveIncome - (needs + wants));
    const savingsPct = effectiveIncome > 0 ? Math.round((savings / effectiveIncome) * 100) : 0;

    return { needs, wants, savings, needsPct, wantsPct, savingsPct, effectiveIncome };
  }, [expenses, totalIncome, targetBudget]);

  const handleSaveBudget = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: SalariedBudget = {
      monthlyTargetBudget: Math.round(tempBudgetAmount),
      categoryBudgets: tempCatBudgets,
    };
    saveBudget(updated);
    setBudget(updated);
    setEditBudgetOpen(false);
    toast.success("Monthly budget goals updated successfully!");
  };

  return (
    <div className="space-y-6">
      {/* Top Main Budget Gauge */}
      <Card className="p-6 border-2 border-indigo-100 bg-gradient-to-br from-paper via-paper to-indigo-50/20">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-hairline">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full border border-indigo-200">
                Monthly Spending Limit
              </span>
              {isOverBudget ? (
                <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-300">
                  ⚠️ Budget Exceeded by {rupee(totalSpent - targetBudget)}
                </Badge>
              ) : isNearLimit ? (
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">
                  ⚡ 85%+ Budget Reached
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">
                  🟢 On Track ({100 - budgetSpentPct}% remaining)
                </Badge>
              )}
            </div>

            <div className="flex items-baseline gap-3 mt-2">
              <span className="text-3xl font-serif font-bold text-ink">
                {rupee(totalSpent)}
              </span>
              <span className="text-sm text-ink-3">
                spent of <span className="font-semibold text-ink-2">{rupee(targetBudget)}</span> target budget
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setTempBudgetAmount(budget.monthlyTargetBudget);
                setTempCatBudgets(budget.categoryBudgets);
                setEditBudgetOpen(true);
              }}
              className="gap-1.5 text-xs"
            >
              <Icon name="sliders" size={14} />
              Set Budget Goals
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onAddExpenseClick}
              className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Icon name="plus" size={14} />
              + Record Spend
            </Button>
          </div>
        </div>

        {/* Progress Bar Gauge */}
        <div className="mt-4 space-y-2">
          <div className="w-full bg-paper-2 h-3.5 rounded-full overflow-hidden border border-hairline p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isOverBudget
                  ? "bg-rose-500"
                  : isNearLimit
                  ? "bg-amber-500"
                  : "bg-indigo-600"
              }`}
              style={{ width: `${Math.min(100, budgetSpentPct)}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-2xs text-ink-3">
            <span>₹0</span>
            <span>50% ({rupee(Math.round(targetBudget * 0.5))})</span>
            <span>Target Cap: {rupee(targetBudget)}</span>
          </div>
        </div>
      </Card>

      {/* 50 / 30 / 20 Rule Analysis */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">50-30-20 Rule Budget Health</h3>
            <p className="text-2xs text-ink-3">
              Standard personal finance allocation benchmark based on your total monthly income ({rupee(rule503020.effectiveIncome)})
            </p>
          </div>
          <Badge variant="outline" className="text-2xs bg-paper-2">
            Indian Financial Benchmark
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Needs Card */}
          <Card className="p-4 border border-indigo-100 bg-indigo-50/15">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-indigo-900">Needs (Target 50%)</span>
              <span className={`text-2xs font-semibold px-2 py-0.5 rounded ${rule503020.needsPct <= 50 ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                {rule503020.needsPct}% of Income
              </span>
            </div>
            <div className="text-xl font-serif font-bold text-ink mt-2 font-mono">
              {rupee(rule503020.needs)}
            </div>
            <p className="text-2xs text-ink-3 mt-1">
              Rent, Groceries, Electricity, Fuel, Health, EMIs
            </p>
          </Card>

          {/* Wants Card */}
          <Card className="p-4 border border-amber-100 bg-amber-50/15">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-900">Wants (Target 30%)</span>
              <span className={`text-2xs font-semibold px-2 py-0.5 rounded ${rule503020.wantsPct <= 30 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                {rule503020.wantsPct}% of Income
              </span>
            </div>
            <div className="text-xl font-serif font-bold text-ink mt-2 font-mono">
              {rupee(rule503020.wants)}
            </div>
            <p className="text-2xs text-ink-3 mt-1">
              Dining, Shopping, Movies, OTT &amp; Subscriptions
            </p>
          </Card>

          {/* Savings / Surplus */}
          <Card className="p-4 border border-emerald-100 bg-emerald-50/15">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-900">Savings &amp; Surplus (Target 20%)</span>
              <span className={`text-2xs font-semibold px-2 py-0.5 rounded ${rule503020.savingsPct >= 20 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                {rule503020.savingsPct}% of Income
              </span>
            </div>
            <div className="text-xl font-serif font-bold text-emerald-700 mt-2 font-mono">
              {rupee(rule503020.savings)}
            </div>
            <p className="text-2xs text-ink-3 mt-1">
              Retained in your bank accounts &amp; investments
            </p>
          </Card>
        </div>
      </div>

      {/* Category-wise Budgets & Breakdown */}
      <Card className="p-5 border border-border space-y-4">
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Category-Wise Spends vs Limits</h3>
            <p className="text-2xs text-ink-3">Track where your money is actually going against your customized limits</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNavigateToExpenses}
            className="text-xs text-indigo-600 hover:text-indigo-800"
          >
            View Full Ledger &rarr;
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PERSONAL_EXPENSE_CATEGORIES.map((cat) => {
            const spent = categorySpends[cat.category] || 0;
            const cap = budget.categoryBudgets[cat.category] || 5000;
            const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
            const isOver = spent > cap;

            return (
              <div key={cat.category} className="p-3 rounded-lg border border-hairline bg-paper space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full inline-block"
                      style={{ backgroundColor: cat.color }}
                    />
                    {cat.category}
                  </span>
                  <div className="text-right">
                    <span className={`text-xs font-mono font-semibold ${isOver ? "text-rose-600" : "text-ink"}`}>
                      {rupee(spent)}
                    </span>
                    <span className="text-2xs text-ink-3"> / {rupee(cap)}</span>
                  </div>
                </div>

                <div className="w-full bg-paper-2 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isOver ? "bg-rose-500" : pct >= 85 ? "bg-amber-500" : "bg-indigo-600"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Edit Budget Dialog */}
      <Dialog open={editBudgetOpen} onOpenChange={setEditBudgetOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Set Monthly Spending Limits</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSaveBudget} className="space-y-4 text-xs pt-2">
            <div>
              <label className="font-semibold text-ink block mb-1">
                Overall Monthly Spending Cap (₹ Whole Rupees)
              </label>
              <Input
                type="number"
                value={tempBudgetAmount}
                onChange={(e) => setTempBudgetAmount(Number(e.target.value))}
                className="h-9 font-mono font-bold text-sm"
                required
              />
              <p className="text-2xs text-ink-3 mt-1">
                Your target maximum expenditure for this month.
              </p>
            </div>

            <div className="border-t border-hairline pt-3 space-y-3">
              <span className="font-semibold text-ink block">Category Limits (₹)</span>
              <div className="grid grid-cols-2 gap-3">
                {PERSONAL_EXPENSE_CATEGORIES.map((cat) => (
                  <div key={cat.category}>
                    <label className="text-2xs text-ink-2 block mb-1 truncate">{cat.category}</label>
                    <Input
                      type="number"
                      value={tempCatBudgets[cat.category] ?? 0}
                      onChange={(e) =>
                        setTempCatBudgets({
                          ...tempCatBudgets,
                          [cat.category]: Number(e.target.value),
                        })
                      }
                      className="h-7 text-xs font-mono"
                    />
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditBudgetOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Save Budget Goals
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
