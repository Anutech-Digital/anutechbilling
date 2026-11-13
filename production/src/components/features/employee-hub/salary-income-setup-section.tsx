"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { toast } from "sonner";
import {
  type SalariedIncome,
  loadIncome,
  saveIncome,
} from "@/lib/employee-hub/personal-finance-store";

interface Props {
  onIncomeSaved: (income: SalariedIncome) => void;
  onNavigateToOverview: () => void;
}

export function SalaryIncomeSetupSection({ onIncomeSaved, onNavigateToOverview }: Props) {
  const [income, setIncome] = React.useState<SalariedIncome>(loadIncome);
  const [employerName, setEmployerName] = React.useState(income.employerName);
  const [monthlyInHand, setMonthlyInHand] = React.useState(income.monthlyInHand);
  const [salaryDay, setSalaryDay] = React.useState(income.salaryDayOfMonth);
  const [otherIncome, setOtherIncome] = React.useState(income.otherMonthlyIncome);

  // Compute days until next salary
  const daysUntilSalary = React.useMemo(() => {
    const today = new Date();
    const currentDay = today.getDate();
    if (currentDay === salaryDay) return 0;
    if (currentDay < salaryDay) return salaryDay - currentDay;
    // Next month
    const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    return daysInCurrentMonth - currentDay + salaryDay;
  }, [salaryDay]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (monthlyInHand <= 0) {
      toast.error("Please enter a valid monthly in-hand salary.");
      return;
    }
    const updated: SalariedIncome = {
      employerName: employerName.trim() || "Employer",
      monthlyInHand: Math.round(monthlyInHand),
      salaryDayOfMonth: Math.min(31, Math.max(1, salaryDay)),
      otherMonthlyIncome: Math.round(otherIncome),
    };
    saveIncome(updated);
    setIncome(updated);
    onIncomeSaved(updated);
    toast.success("Salary & income details updated successfully!");
    onNavigateToOverview();
  };

  const annualInHand = (monthlyInHand + otherIncome) * 12;
  const dailyDisposable = Math.round((monthlyInHand + otherIncome) / 30);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Overview Banner */}
      <Card className="p-6 border-2 border-indigo-100 bg-gradient-to-br from-paper to-indigo-50/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-hairline">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded border border-indigo-200">
                Income Profile
              </span>
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">
                {daysUntilSalary === 0 ? "🎉 Salary Day Today!" : `⏳ ${daysUntilSalary} Days to Next Salary`}
              </Badge>
            </div>
            <h2 className="text-xl font-serif font-bold text-ink mt-1.5">
              Monthly In-Hand: {rupee(monthlyInHand + otherIncome)}
            </h2>
            <p className="text-xs text-ink-3">
              Net credited amount after PF, Professional Tax and TDS deductions.
            </p>
          </div>

          <div className="text-left sm:text-right">
            <span className="text-2xs text-ink-3 uppercase block">Annual Take-Home</span>
            <span className="text-xl font-serif font-bold text-indigo-950 font-mono">
              {rupee(annualInHand)}
            </span>
            <span className="text-2xs text-ink-3 block">~{rupee(dailyDisposable)} / day</span>
          </div>
        </div>

        {/* Configuration Form */}
        <form onSubmit={handleSubmit} className="pt-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div>
              <label className="font-semibold text-ink block mb-1">
                Company / Employer Name
              </label>
              <Input
                type="text"
                placeholder="e.g. Infosys, TCS, Anutech Digital"
                value={employerName}
                onChange={(e) => setEmployerName(e.target.value)}
              />
              <span className="text-2xs text-ink-3 mt-1 block">
                Appears on salary credit tags and rent receipts.
              </span>
            </div>

            <div>
              <label className="font-semibold text-ink block mb-1">
                Monthly Net In-Hand Salary (₹)
              </label>
              <Input
                type="number"
                placeholder="85000"
                value={monthlyInHand}
                onChange={(e) => setMonthlyInHand(Number(e.target.value) || 0)}
                className="font-mono text-sm"
              />
              <span className="text-2xs text-ink-3 mt-1 block">
                Exact take-home credited to your bank account each month.
              </span>
            </div>

            <div>
              <label className="font-semibold text-ink block mb-1">
                Salary Credit Day of Month
              </label>
              <select
                value={salaryDay}
                onChange={(e) => setSalaryDay(Number(e.target.value))}
                className="w-full px-3 py-2 border rounded border-hairline bg-paper text-xs"
              >
                <option value={1}>1st of every month (Most Companies)</option>
                <option value={5}>5th of every month</option>
                <option value={7}>7th of every month</option>
                <option value={10}>10th of every month</option>
                <option value={25}>25th of every month</option>
                <option value={28}>28th of every month</option>
                <option value={30}>30th / Last day of month</option>
                <option value={31}>31st of month</option>
              </select>
              <span className="text-2xs text-ink-3 mt-1 block">
                Used to calculate days until your next paycheck.
              </span>
            </div>

            <div>
              <label className="font-semibold text-ink block mb-1">
                Other Monthly Inflows (Interest, Dividends, Side Income) (₹)
              </label>
              <Input
                type="number"
                placeholder="2500"
                value={otherIncome}
                onChange={(e) => setOtherIncome(Number(e.target.value) || 0)}
                className="font-mono text-sm"
              />
              <span className="text-2xs text-ink-3 mt-1 block">
                Recurring monthly interest or additional side cash flow.
              </span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-hairline">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onNavigateToOverview}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
            >
              <Icon name="check" size={14} />
              Save &amp; Update Dashboard
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
