"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";

interface IncomeCashflowSectionProps {
  onSyncToItr?: (data: {
    grossSalary: number;
    exemptHra: number;
    professionalTax: number;
    otherIncome: number;
  }) => void;
}

export function IncomeCashflowSection({ onSyncToItr }: IncomeCashflowSectionProps) {
  // Salary Inflows
  const [annualGrossCtc, setAnnualGrossCtc] = React.useState<number>(1200000); // 12 LPA
  const [basicPct, setBasicPct] = React.useState<number>(50); // 50%
  const [hraPct, setHraPct] = React.useState<number>(20); // 20%
  const [monthlyProfTax, setMonthlyProfTax] = React.useState<number>(200); // ₹200/mo
  const [monthlyTdsEstimate, setMonthlyTdsEstimate] = React.useState<number>(5500); // ~₹66k/yr

  // Other Incomes (Monthly)
  const [monthlyBankInterest, setMonthlyBankInterest] = React.useState<number>(800);
  const [monthlyFdInterest, setMonthlyFdInterest] = React.useState<number>(1200);
  const [monthlyDividends, setMonthlyDividends] = React.useState<number>(500);
  const [monthlySideIncome, setMonthlySideIncome] = React.useState<number>(0);

  // Outflows & Savings Goal
  const [monthlyLivingExpenses, setMonthlyLivingExpenses] = React.useState<number>(45000);
  const [currentLiquidSavings, setCurrentLiquidSavings] = React.useState<number>(300000); // ₹3L

  // Computed Salary Breakdown
  const salaryBreakdown = React.useMemo(() => {
    const monthlyGross = Math.round(annualGrossCtc / 12);
    const monthlyBasic = Math.round((monthlyGross * basicPct) / 100);
    const monthlyHra = Math.round((monthlyGross * hraPct) / 100);
    const monthlySpecialAllowance = Math.max(0, monthlyGross - monthlyBasic - monthlyHra);

    // Statutory Deductions
    // Employee EPF is 12% of basic (capped or actual)
    const monthlyEpf = Math.round(monthlyBasic * 0.12);
    const totalDeductions = monthlyEpf + monthlyProfTax + monthlyTdsEstimate;

    // Monthly In-Hand
    const monthlyNetInHand = Math.max(0, monthlyGross - totalDeductions);

    return {
      monthlyGross,
      monthlyBasic,
      monthlyHra,
      monthlySpecialAllowance,
      monthlyEpf,
      monthlyProfTax,
      monthlyTdsEstimate,
      totalDeductions,
      monthlyNetInHand,
      annualInHand: monthlyNetInHand * 12,
    };
  }, [annualGrossCtc, basicPct, hraPct, monthlyProfTax, monthlyTdsEstimate]);

  // Total Inflows & Cashflow
  const cashflow = React.useMemo(() => {
    const totalOtherMonthly =
      monthlyBankInterest + monthlyFdInterest + monthlyDividends + monthlySideIncome;
    const totalMonthlyInflows = salaryBreakdown.monthlyNetInHand + totalOtherMonthly;

    const monthlySurplus = totalMonthlyInflows - monthlyLivingExpenses;
    const savingsRate =
      totalMonthlyInflows > 0 ? Math.round((monthlySurplus / totalMonthlyInflows) * 100) : 0;

    const emergencyMonths =
      monthlyLivingExpenses > 0
        ? Math.round((currentLiquidSavings / monthlyLivingExpenses) * 10) / 10
        : 0;

    return {
      totalOtherMonthly,
      totalMonthlyInflows,
      monthlySurplus,
      savingsRate,
      emergencyMonths,
    };
  }, [salaryBreakdown.monthlyNetInHand, monthlyBankInterest, monthlyFdInterest, monthlyDividends, monthlySideIncome, monthlyLivingExpenses, currentLiquidSavings]);

  const handleSyncToItr = () => {
    if (onSyncToItr) {
      onSyncToItr({
        grossSalary: annualGrossCtc,
        exemptHra: salaryBreakdown.monthlyHra * 12,
        professionalTax: monthlyProfTax * 12,
        otherIncome: cashflow.totalOtherMonthly * 12,
      });
      toast.success("Income details synced to ITR-1 Filing Assistant!");
    } else {
      toast.success("Income figures verified. Ready for Tax computation.");
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Summary Cockpit ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 border-emerald-200 bg-emerald-50/25">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span className="font-medium text-emerald-800">Monthly Net In-Hand</span>
            <Icon name="rupee" size={16} className="text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-serif font-bold text-ink">
            ₹{salaryBreakdown.monthlyNetInHand.toLocaleString("en-IN")}
          </div>
          <div className="text-2xs text-ink-3 mt-1">
            Annual: ₹{salaryBreakdown.annualInHand.toLocaleString("en-IN")}
          </div>
        </Card>

        <Card className="p-4 border-amber-200 bg-amber-50/25">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span className="font-medium text-amber-800">Monthly Living Spends</span>
            <Icon name="tag" size={16} className="text-amber-600" />
          </div>
          <div className="mt-2 text-2xl font-serif font-bold text-ink">
            ₹{monthlyLivingExpenses.toLocaleString("en-IN")}
          </div>
          <div className="text-2xs text-ink-3 mt-1">Rent, EMIs, Bills & Groceries</div>
        </Card>

        <Card className="p-4 border-indigo-200 bg-indigo-50/25">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span className="font-medium text-indigo-800">Net Monthly Savings</span>
            <Badge variant="outline" className="bg-indigo-100 text-indigo-800 text-2xs">
              {cashflow.savingsRate}% Saved
            </Badge>
          </div>
          <div className="mt-2 text-2xl font-serif font-bold text-ink">
            ₹{cashflow.monthlySurplus.toLocaleString("en-IN")}
          </div>
          <div className="text-2xs text-ink-3 mt-1">Surplus added to investments / bank</div>
        </Card>

        <Card className="p-4 border-sky-200 bg-sky-50/25">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span className="font-medium text-sky-800">Emergency Fund Health</span>
            <Icon name="shield" size={16} className="text-sky-600" />
          </div>
          <div className="mt-2 text-2xl font-serif font-bold text-ink">
            {cashflow.emergencyMonths} <span className="text-sm font-sans font-normal text-ink-3">Months</span>
          </div>
          <div className="text-2xs text-ink-3 mt-1">
            {cashflow.emergencyMonths >= 6 ? "Safe (Target ≥ 6 months met)" : "Build up to 6 months runway"}
          </div>
        </Card>
      </div>

      {/* ── Salary Structure & Deduction Breakdown ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5 space-y-4 border-hairline">
          <div className="flex items-center justify-between border-b border-hairline pb-2">
            <div>
              <h3 className="font-semibold text-sm text-ink">Salary CTC & In-Hand Structure</h3>
              <p className="text-xs text-ink-3">Configure your CTC components to see exact take-home pay</p>
            </div>
            <Badge variant="outline" className="font-mono text-xs">
              ₹{(annualGrossCtc / 100000).toFixed(1)} LPA
            </Badge>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="font-medium text-ink-2 block mb-1">Annual CTC / Gross Salary (₹)</label>
              <input
                type="number"
                value={annualGrossCtc}
                onChange={(e) => setAnnualGrossCtc(Math.max(0, Number(e.target.value) || 0))}
                className="w-full font-mono text-sm px-3 py-1.5 border rounded border-hairline bg-paper"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-medium text-ink-2 block mb-1">Basic Salary ({basicPct}%)</label>
                <div className="font-mono text-xs p-2 rounded bg-paper-2 font-medium">
                  ₹{salaryBreakdown.monthlyBasic.toLocaleString("en-IN")}/mo
                </div>
              </div>
              <div>
                <label className="font-medium text-ink-2 block mb-1">HRA ({hraPct}%)</label>
                <div className="font-mono text-xs p-2 rounded bg-paper-2 font-medium">
                  ₹{salaryBreakdown.monthlyHra.toLocaleString("en-IN")}/mo
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-hairline space-y-2">
              <span className="font-semibold text-ink-2 block">Monthly Payroll Deductions</span>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-2xs text-ink-3 block">EPF (12% of Basic)</label>
                  <div className="font-mono text-2xs p-1.5 bg-paper-2 rounded">
                    ₹{salaryBreakdown.monthlyEpf.toLocaleString("en-IN")}
                  </div>
                </div>
                <div>
                  <label className="text-2xs text-ink-3 block">Prof. Tax (PT)</label>
                  <input
                    type="number"
                    value={monthlyProfTax}
                    onChange={(e) => setMonthlyProfTax(Number(e.target.value) || 0)}
                    className="w-full font-mono text-2xs p-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
                <div>
                  <label className="text-2xs text-ink-3 block">TDS Withheld</label>
                  <input
                    type="number"
                    value={monthlyTdsEstimate}
                    onChange={(e) => setMonthlyTdsEstimate(Number(e.target.value) || 0)}
                    className="w-full font-mono text-2xs p-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-emerald-50/50 border border-emerald-200 flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-emerald-900 block">Monthly Credited Salary</span>
                <span className="text-2xs text-emerald-700">Gross (₹{salaryBreakdown.monthlyGross.toLocaleString("en-IN")}) − Deductions (₹{salaryBreakdown.totalDeductions.toLocaleString("en-IN")})</span>
              </div>
              <span className="font-mono text-base font-bold text-emerald-900">
                ₹{salaryBreakdown.monthlyNetInHand.toLocaleString("en-IN")}
              </span>
            </div>
          </div>
        </Card>

        {/* ── Other Incomes & Cashflow Management ── */}
        <Card className="p-5 space-y-4 border-hairline">
          <div className="flex items-center justify-between border-b border-hairline pb-2">
            <div>
              <h3 className="font-semibold text-sm text-ink">Other Income Streams (Monthly)</h3>
              <p className="text-xs text-ink-3">Track interest, dividends & side earnings for ITR & cashflow</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleSyncToItr} className="gap-1.5">
              <Icon name="rupee" size={14} />
              Sync to ITR
            </Button>
          </div>

          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-medium text-ink-2 block mb-1">Savings Bank Interest (₹)</label>
                <input
                  type="number"
                  value={monthlyBankInterest}
                  onChange={(e) => setMonthlyBankInterest(Number(e.target.value) || 0)}
                  className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                />
                <span className="text-3xs text-ink-3">Section 80TTA exempt up to ₹10k/yr</span>
              </div>

              <div>
                <label className="font-medium text-ink-2 block mb-1">Fixed Deposit Interest (₹)</label>
                <input
                  type="number"
                  value={monthlyFdInterest}
                  onChange={(e) => setMonthlyFdInterest(Number(e.target.value) || 0)}
                  className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                />
                <span className="text-3xs text-ink-3">TDS deducted u/s 194A</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-medium text-ink-2 block mb-1">Stock Dividends (₹)</label>
                <input
                  type="number"
                  value={monthlyDividends}
                  onChange={(e) => setMonthlyDividends(Number(e.target.value) || 0)}
                  className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                />
              </div>

              <div>
                <label className="font-medium text-ink-2 block mb-1">Side / Freelance Income (₹)</label>
                <input
                  type="number"
                  value={monthlySideIncome}
                  onChange={(e) => setMonthlySideIncome(Number(e.target.value) || 0)}
                  className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-hairline">
              <label className="font-medium text-ink-2 block mb-1">Emergency Fund Liquid Savings (₹)</label>
              <input
                type="number"
                value={currentLiquidSavings}
                onChange={(e) => setCurrentLiquidSavings(Number(e.target.value) || 0)}
                className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
              />
              <p className="text-3xs text-ink-3 mt-1">Savings accounts + Liquid MFs available instantly</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
