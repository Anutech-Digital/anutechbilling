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
  type PersonalExpense,
  type PersonalExpenseCategory,
  PERSONAL_EXPENSE_CATEGORIES,
} from "./personal-expenses-section";
import {
  type SalariedBudget,
  loadBudget,
  saveBudget,
  type SalariedIncome,
  loadIncome,
} from "@/lib/employee-hub/personal-finance-store";
import { toast } from "sonner";

interface Props {
  expenses: PersonalExpense[];
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
  const [income] = React.useState<SalariedIncome>(loadIncome);
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

  // Compute spend totals
  const totalSpent = React.useMemo(() => {
    return expenses.reduce((sum, e) => sum + e.amountRupees, 0);
  }, [expenses]);

  const targetBudget = budget.monthlyTargetBudget;
  const remainingBudget = Math.max(0, targetBudget - totalSpent);
  const budgetSpentPct = targetBudget > 0 ? Math.min(100, Math.round((totalSpent / targetBudget) * 100)) : 0;
  const isOverBudget = totalSpent > targetBudget;
  const isNearLimit = !isOverBudget && budgetSpentPct >= 85;

  // Category breakdown
  const categorySpends = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const exp of expenses) {
      map[exp.category] = (map[exp.category] || 0) + exp.amountRupees;
    }
    return map;
  }, [expenses]);

  // 50-30-20 Rule calculation
  const rule503020 = React.useMemo(() => {
    let needs = 0;
    let wants = 0;

    for (const exp of expenses) {
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

    const totalIncome = income.monthlyInHand;
    const needsPct = totalIncome > 0 ? Math.round((needs / totalIncome) * 100) : 0;
    const wantsPct = totalIncome > 0 ? Math.round((wants / totalIncome) * 100) : 0;
    const savings = Math.max(0, totalIncome - (needs + wants));
    const savingsPct = totalIncome > 0 ? Math.round((savings / totalIncome) * 100) : 0;

    return { needs, wants, savings, needsPct, wantsPct, savingsPct };
  }, [expenses, income.monthlyInHand]);

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
              className="gap-1.5"
            >
              <Icon name="sliders" size={14} />
              Set Budget Limit
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onAddExpenseClick}
              className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Icon name="plus" size={14} />
              + Add Expense
            </Button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-4 space-y-2">
          <div className="w-full bg-paper-2 h-3.5 rounded-full overflow-hidden flex border border-hairline">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                isOverBudget
                  ? "bg-rose-500"
                  : isNearLimit
                  ? "bg-amber-500"
                  : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, budgetSpentPct)}%` }}
            />
          </div>

          <div className="flex justify-between text-xs text-ink-3 font-mono">
            <span>₹0 Spent</span>
            <span className="font-medium text-ink">
              {budgetSpentPct}% Used ({rupee(remainingBudget)} left)
            </span>
            <span>Target: {rupee(targetBudget)}</span>
          </div>
        </div>
      </Card>

      {/* 50-30-20 Indian Salaried Budget Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 border-l-4 border-l-indigo-500 bg-paper">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-2">Needs (Rent, Bills, Food)</span>
            <span className="text-2xs font-mono px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold">
              Target: 50%
            </span>
          </div>
          <div className="text-2xl font-serif font-bold text-ink mt-2">
            {rupee(rule503020.needs)}
          </div>
          <div className="flex items-center justify-between text-xs text-ink-3 mt-1">
            <span>{rule503020.needsPct}% of Take-Home</span>
            <span className={rule503020.needsPct <= 50 ? "text-emerald-600 font-medium" : "text-amber-600"}>
              {rule503020.needsPct <= 50 ? "Optimal" : "Slightly High"}
            </span>
          </div>
        </Card>

        <Card className="p-4 border-l-4 border-l-amber-500 bg-paper">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-2">Wants (Dining, Shopping, OTT)</span>
            <span className="text-2xs font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">
              Target: 30%
            </span>
          </div>
          <div className="text-2xl font-serif font-bold text-ink mt-2">
            {rupee(rule503020.wants)}
          </div>
          <div className="flex items-center justify-between text-xs text-ink-3 mt-1">
            <span>{rule503020.wantsPct}% of Take-Home</span>
            <span className={rule503020.wantsPct <= 30 ? "text-emerald-600 font-medium" : "text-rose-600"}>
              {rule503020.wantsPct <= 30 ? "In Control" : "Over 30% Limit"}
            </span>
          </div>
        </Card>

        <Card className="p-4 border-l-4 border-l-emerald-500 bg-paper">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-2">Monthly Surplus / Savings</span>
            <span className="text-2xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">
              Target: 20%+
            </span>
          </div>
          <div className="text-2xl font-serif font-bold text-emerald-600 mt-2">
            {rupee(rule503020.savings)}
          </div>
          <div className="flex items-center justify-between text-xs text-ink-3 mt-1">
            <span>{rule503020.savingsPct}% Savings Rate</span>
            <span className="text-emerald-600 font-medium">Ready for SIP &amp; Buffer</span>
          </div>
        </Card>
      </div>

      {/* Category-Wise Progress Bars */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Category-Wise Spends &amp; Caps</h3>
            <p className="text-xs text-ink-3">Track where your salary goes each month</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onNavigateToExpenses} className="gap-1.5 text-xs">
              <Icon name="tag" size={14} />
              View All Spends ({expenses.length})
            </Button>
            <Button variant="outline" size="sm" onClick={onNavigateToBanks} className="gap-1.5 text-xs">
              <Icon name="upload_cloud" size={14} />
              Import Bank Statement
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PERSONAL_EXPENSE_CATEGORIES.map((catItem) => {
            const spent = categorySpends[catItem.category] || 0;
            const catBudget = budget.categoryBudgets[catItem.category] || 5000;
            const pct = catBudget > 0 ? Math.min(100, Math.round((spent / catBudget) * 100)) : 0;
            const isCatOver = spent > catBudget;

            return (
              <div
                key={catItem.category}
                className="p-3 rounded-lg border border-hairline bg-paper hover:bg-paper-2/30 transition-colors space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center text-white text-xs"
                      style={{ backgroundColor: catItem.color }}
                    >
                      <Icon name={catItem.icon} size={14} />
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-ink block">{catItem.category}</span>
                      <span className="text-2xs text-ink-3">Cap: {rupee(catBudget)}</span>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className={`text-xs font-bold font-mono ${isCatOver ? "text-rose-600" : "text-ink"}`}>
                      {rupee(spent)}
                    </span>
                    <span className="text-2xs text-ink-3 block">
                      {pct}% of cap
                    </span>
                  </div>
                </div>

                <div className="w-full bg-paper-2 h-2 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: isCatOver ? "#EF4444" : catItem.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Edit Budget Goals Dialog */}
      <Dialog open={editBudgetOpen} onOpenChange={setEditBudgetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Configure Monthly Budget Goals</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSaveBudget} className="space-y-4 text-xs pt-2">
            <div>
              <label className="font-semibold text-ink block mb-1">
                Total Monthly Target Spending Limit (₹)
              </label>
              <Input
                type="number"
                value={tempBudgetAmount}
                onChange={(e) => setTempBudgetAmount(Number(e.target.value) || 0)}
                className="font-mono text-sm"
              />
              <span className="text-2xs text-ink-3 mt-1 block">
                Total cap for all living expenses this month.
              </span>
            </div>

            <div className="space-y-2 pt-2 border-t border-hairline max-h-60 overflow-y-auto pr-1">
              <span className="font-semibold text-ink block">Category Limits (₹)</span>
              {PERSONAL_EXPENSE_CATEGORIES.map((c) => (
                <div key={c.category} className="flex items-center justify-between gap-3 py-1">
                  <span className="text-ink-2">{c.category}</span>
                  <Input
                    type="number"
                    value={tempCatBudgets[c.category] || 0}
                    onChange={(e) =>
                      setTempCatBudgets({
                        ...tempCatBudgets,
                        [c.category]: Number(e.target.value) || 0,
                      })
                    }
                    className="w-28 text-right font-mono text-xs h-8"
                  />
                </div>
              ))}
            </div>

            <DialogFooter className="pt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditBudgetOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Save Budget
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
