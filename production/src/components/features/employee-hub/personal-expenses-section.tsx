"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { FormField } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { toast } from "sonner";

export interface PersonalExpense {
  id: string;
  date: string;
  category: PersonalExpenseCategory;
  description: string;
  amountRupees: number;
  paymentMode: "UPI" | "Credit Card" | "Debit Card" | "Net Banking" | "Cash";
  tags?: string[];
}

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

const STORAGE_KEY = "salaried_pro_personal_expenses_v1";

const DEFAULT_PERSONAL_EXPENSES: PersonalExpense[] = [
  {
    id: "pe-1",
    date: "2026-11-01",
    category: "Housing & Rent",
    description: "Monthly Apartment Rent (Landlord Transfer)",
    amountRupees: 22000,
    paymentMode: "Net Banking",
  },
  {
    id: "pe-2",
    date: "2026-11-03",
    category: "Food & Groceries",
    description: "Monthly Household Groceries at DMart",
    amountRupees: 6450,
    paymentMode: "UPI",
  },
  {
    id: "pe-3",
    date: "2026-11-04",
    category: "Utilities & Bills",
    description: "Electricity Bill (State Discom) + LPG Refill",
    amountRupees: 2180,
    paymentMode: "UPI",
  },
  {
    id: "pe-4",
    date: "2026-11-06",
    category: "Fuel & Commute",
    description: "HPCL Petrol Pump Fuel Refill for Car",
    amountRupees: 3500,
    paymentMode: "Credit Card",
  },
  {
    id: "pe-5",
    date: "2026-11-08",
    category: "Subscriptions & OTT",
    description: "Netflix Premium + Spotify Annual Sub",
    amountRupees: 949,
    paymentMode: "Credit Card",
  },
  {
    id: "pe-6",
    date: "2026-11-10",
    category: "Entertainment & Dining",
    description: "Weekend Dinner & Swiggy Food Orders",
    amountRupees: 1840,
    paymentMode: "UPI",
  },
];

interface Props {
  monthlySalaryRupees?: number;
  onNavigateToBankImport?: () => void;
}

export function PersonalExpensesSection({
  monthlySalaryRupees = 100000,
  onNavigateToBankImport,
}: Props) {
  const [expenses, setExpenses] = React.useState<PersonalExpense[]>(() => {
    if (typeof window === "undefined") return DEFAULT_PERSONAL_EXPENSES;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // fallback
    }
    return DEFAULT_PERSONAL_EXPENSES;
  });

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  // Form state
  const [date, setDate] = React.useState<string>(istToday());
  const [category, setCategory] = React.useState<PersonalExpenseCategory>("Food & Groceries");
  const [description, setDescription] = React.useState<string>("");
  const [amountRupees, setAmountRupees] = React.useState<number>(500);
  const [paymentMode, setPaymentMode] = React.useState<PersonalExpense["paymentMode"]>("UPI");

  // Sync when expenses are updated from bank statement or other sections
  React.useEffect(() => {
    const handleUpdate = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) setExpenses(parsed);
        }
      } catch {
        // ignore
      }
    };

    const handleOpenAdd = () => {
      setDialogOpen(true);
    };

    window.addEventListener("salaried_pro_expenses_updated", handleUpdate);
    window.addEventListener("salaried_pro_open_add_expense", handleOpenAdd);
    return () => {
      window.removeEventListener("salaried_pro_expenses_updated", handleUpdate);
      window.removeEventListener("salaried_pro_open_add_expense", handleOpenAdd);
    };
  }, []);

  // Save to localStorage
  const saveExpenses = React.useCallback((items: PersonalExpense[]) => {
    setExpenses(items);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        window.dispatchEvent(new Event("salaried_pro_expenses_updated"));
      } catch {
        // ignore
      }
    }
  }, []);

  // Compute metrics
  const totalSpent = React.useMemo(() => {
    return expenses.reduce((sum, e) => sum + e.amountRupees, 0);
  }, [expenses]);

  const savingsRupees = Math.max(0, monthlySalaryRupees - totalSpent);
  const savingsRatePct = monthlySalaryRupees > 0 ? Math.round((savingsRupees / monthlySalaryRupees) * 100) : 0;

  // Breakdown by category
  const categoryBreakdown = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const exp of expenses) {
      map[exp.category] = (map[exp.category] || 0) + exp.amountRupees;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [expenses]);

  // Filtered expenses
  const filteredExpenses = React.useMemo(() => {
    return expenses.filter((e) => {
      const matchCat = categoryFilter === "all" || e.category === categoryFilter;
      const matchQuery =
        !searchQuery.trim() ||
        e.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.paymentMode.toLowerCase().includes(searchQuery.toLowerCase());
      return matchCat && matchQuery;
    });
  }, [expenses, categoryFilter, searchQuery]);

  const handleAddExpense = (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      toast.error("Please enter a description for the expense.");
      return;
    }
    if (amountRupees <= 0) {
      toast.error("Please enter an amount greater than ₹0.");
      return;
    }

    const newExpense: PersonalExpense = {
      id: `pe-${Date.now()}`,
      date,
      category,
      description: description.trim(),
      amountRupees: Math.round(amountRupees),
      paymentMode,
    };

    const updated = [newExpense, ...expenses];
    saveExpenses(updated);
    toast.success(`Recorded expense of ${rupee(newExpense.amountRupees)}`);
    setDialogOpen(false);
    setDescription("");
    setAmountRupees(500);
  };

  const handleDeleteExpense = (id: string) => {
    const updated = expenses.filter((e) => e.id !== id);
    saveExpenses(updated);
    toast.success("Expense removed.");
  };

  const handleExportCSV = () => {
    const headers = ["Date", "Category", "Description", "Amount (INR)", "Payment Mode"];
    const rows = expenses.map((e) => [
      e.date,
      `"${e.category}"`,
      `"${e.description.replace(/"/g, '""')}"`,
      e.amountRupees,
      e.paymentMode,
    ]);
    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `personal-expenses-${istToday()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Downloaded expenses CSV report.");
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Action */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-2/60 p-4 md:p-5 rounded-xl border border-border">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
              Personal Finance
            </Badge>
            <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
              Salaried Pro Hub
            </span>
          </div>
          <h2 className="font-serif text-xl md:text-2xl tracking-tight">
            Personal Expenses &amp; Monthly Budget
          </h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl">
            Record personal daily spends (UPI, Cards, Rent, EMIs), monitor your monthly savings rate,
            or import transactions directly from your bank statement.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {onNavigateToBankImport && (
            <Button
              variant="outline"
              icon="arrow-up-right"
              onClick={onNavigateToBankImport}
              className="text-xs"
            >
              Import Bank Statement
            </Button>
          )}
          <Button
            variant="default"
            icon="plus"
            onClick={() => setDialogOpen(true)}
            className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            + Add Expense
          </Button>
        </div>
      </div>

      {/* Overview Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-surface border-border">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">Monthly Inflow (Salary)</p>
          <p className="font-serif text-2xl font-bold text-ink mt-1">{rupee(monthlySalaryRupees)}</p>
          <p className="text-2xs text-ink-3 mt-1">Net estimated take-home pay</p>
        </Card>

        <Card className="p-4 bg-surface border-border">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">Total Expenses Recorded</p>
          <p className="font-serif text-2xl font-bold text-red-600 mt-1">{rupee(totalSpent)}</p>
          <p className="text-2xs text-ink-3 mt-1">{expenses.length} personal entries this month</p>
        </Card>

        <Card className="p-4 bg-surface border-border">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">Monthly Net Savings</p>
          <p className="font-serif text-2xl font-bold text-emerald-600 mt-1">{rupee(savingsRupees)}</p>
          <p className="text-2xs text-ink-3 mt-1">Salary remaining after spends</p>
        </Card>

        <Card className="p-4 bg-surface border-border">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">Personal Savings Rate</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="font-serif text-2xl font-bold text-indigo-600">{savingsRatePct}%</span>
            <span className="text-xs text-ink-3 font-medium">of monthly pay</span>
          </div>
          <div className="w-full bg-surface-3 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-indigo-600 h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, savingsRatePct))}%` }}
            />
          </div>
        </Card>
      </div>

      {/* Category Breakdown Chips */}
      {categoryBreakdown.length > 0 && (
        <Card className="p-4 bg-surface border-border space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider font-semibold text-ink-2">
              Expense Breakdown by Category
            </p>
            <span className="text-2xs text-ink-3">Click on any category to filter</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCategoryFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                categoryFilter === "all"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-surface-2 text-ink-2 hover:bg-surface-3"
              }`}
            >
              All Categories ({expenses.length})
            </button>
            {categoryBreakdown.map(([cat, amount]) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(categoryFilter === cat ? "all" : cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                  categoryFilter === cat
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                }`}
              >
                <span>{cat}</span>
                <span className="font-semibold opacity-90">{rupee(amount)}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Input
            placeholder="Search description, category, mode..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="text-xs pl-8"
          />
          <span className="absolute left-2.5 top-2.5 text-ink-3">
            <Icon name="search" className="w-3.5 h-3.5" />
          </span>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <Button variant="outline" icon="download" onClick={handleExportCSV} className="text-xs">
            Export CSV
          </Button>
        </div>
      </div>

      {/* Expenses List */}
      <Card className="p-0 overflow-hidden border-border bg-surface">
        {filteredExpenses.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium text-ink">No expenses found</p>
            <p className="text-xs text-ink-3">
              {searchQuery || categoryFilter !== "all"
                ? "Try clearing your search or category filters."
                : "Click '+ Add Expense' to record your first personal spend."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredExpenses.map((exp) => {
              const catConfig = PERSONAL_EXPENSE_CATEGORIES.find((c) => c.category === exp.category);
              return (
                <div
                  key={exp.id}
                  className="p-3.5 md:p-4 flex items-center justify-between gap-4 hover:bg-surface-2/40 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: `${catConfig?.color || "#6366F1"}15`,
                        color: catConfig?.color || "#6366F1",
                      }}
                    >
                      <Icon name={(catConfig?.icon as any) || "tag"} className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs md:text-sm font-semibold text-ink truncate">
                        {exp.description}
                      </p>
                      <div className="flex items-center gap-2 text-2xs text-ink-3 mt-0.5 flex-wrap">
                        <span>{formatDate(exp.date, "short")}</span>
                        <span>•</span>
                        <span className="font-medium text-ink-2">{exp.category}</span>
                        <span>•</span>
                        <Badge className="text-2xs py-0 h-4 bg-surface-2 text-ink-2 font-normal">
                          {exp.paymentMode}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-serif text-sm md:text-base font-bold text-red-600">
                      -{rupee(exp.amountRupees)}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteExpense(exp.id)}
                      className="text-ink-4 hover:text-red-600 transition-colors p-1"
                      title="Delete expense"
                    >
                      <Icon name="trash" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Add Expense Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleAddExpense}>
            <DialogHeader>
              <DialogTitle>Record Personal Expense</DialogTitle>
              <DialogDescription>
                Track personal out-of-pocket expenses (Rent, Groceries, Fuel, Bills, EMIs).
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Date">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </FormField>

                <FormField label="Amount (₹ Whole Rupees)">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={amountRupees}
                    onChange={(e) => setAmountRupees(Number(e.target.value))}
                    required
                  />
                </FormField>
              </div>

              <FormField label="Category">
                <Select
                  value={category}
                  onValueChange={(val) => setCategory(val as PersonalExpenseCategory)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERSONAL_EXPENSE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.category} value={cat.category}>
                        {cat.category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Description / Details">
                <Input
                  placeholder="e.g. DMart monthly groceries / Swiggy dinner / Petrol refill"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                />
              </FormField>

              <FormField label="Payment Method">
                <Select
                  value={paymentMode}
                  onValueChange={(val) => setPaymentMode(val as PersonalExpense["paymentMode"])}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Payment Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UPI">UPI (GPay / PhonePe / Paytm)</SelectItem>
                    <SelectItem value="Credit Card">Credit Card</SelectItem>
                    <SelectItem value="Debit Card">Debit Card</SelectItem>
                    <SelectItem value="Net Banking">Net Banking</SelectItem>
                    <SelectItem value="Cash">Cash</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Save Expense
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
