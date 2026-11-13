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
import {
  type PersonalTransaction,
  type TransactionType,
  type PersonalExpenseCategory,
  type PersonalIncomeCategory,
  type SalariedBankAccount,
  PERSONAL_EXPENSE_CATEGORIES,
  PERSONAL_INCOME_CATEGORIES,
  loadTransactions,
  saveTransactions,
  loadBankAccounts,
  saveBankAccounts,
  STORAGE_EXPENSES_KEY,
} from "@/lib/employee-hub/personal-finance-store";

// Re-export types for backward compatibility
export type { PersonalTransaction as PersonalExpense, PersonalExpenseCategory, PersonalIncomeCategory };
export { PERSONAL_EXPENSE_CATEGORIES, PERSONAL_INCOME_CATEGORIES };

interface Props {
  onNavigateToBankImport?: () => void;
}

export function PersonalExpensesSection({ onNavigateToBankImport }: Props) {
  const [transactions, setTransactions] = React.useState<PersonalTransaction[]>(loadTransactions);
  const [bankAccounts, setBankAccounts] = React.useState<SalariedBankAccount[]>(loadBankAccounts);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [typeFilter, setTypeFilter] = React.useState<"all" | "expense" | "income">("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  // Form State
  const [entryType, setEntryType] = React.useState<TransactionType>("expense");
  const [date, setDate] = React.useState<string>(istToday());
  const [expenseCat, setExpenseCat] = React.useState<PersonalExpenseCategory>("Food & Groceries");
  const [incomeCat, setIncomeCat] = React.useState<PersonalIncomeCategory>("Salary");
  const [description, setDescription] = React.useState<string>("");
  const [amountRupees, setAmountRupees] = React.useState<number>(500);
  const [paymentMode, setPaymentMode] = React.useState<PersonalTransaction["paymentMode"]>("UPI");
  const [selectedBankId, setSelectedBankId] = React.useState<string>("acc-hdfc");

  // Sync when transactions or bank accounts update
  React.useEffect(() => {
    const handleTxnUpdate = () => {
      setTransactions(loadTransactions());
    };

    const handleBankUpdate = () => {
      setBankAccounts(loadBankAccounts());
    };

    const handleOpenAdd = () => {
      setDialogOpen(true);
    };

    window.addEventListener("salaried_pro_expenses_updated", handleTxnUpdate);
    window.addEventListener("salaried_pro_banks_updated", handleBankUpdate);
    window.addEventListener("salaried_pro_open_add_expense", handleOpenAdd);
    return () => {
      window.removeEventListener("salaried_pro_expenses_updated", handleTxnUpdate);
      window.removeEventListener("salaried_pro_banks_updated", handleBankUpdate);
      window.removeEventListener("salaried_pro_open_add_expense", handleOpenAdd);
    };
  }, []);

  // Compute Metrics
  const totalIncome = React.useMemo(() => {
    return transactions
      .filter((t) => t.type === "income")
      .reduce((sum, t) => sum + t.amountRupees, 0);
  }, [transactions]);

  const totalExpense = React.useMemo(() => {
    return transactions
      .filter((t) => t.type !== "income")
      .reduce((sum, t) => sum + t.amountRupees, 0);
  }, [transactions]);

  const netSavings = totalIncome - totalExpense;
  const savingsRatePct = totalIncome > 0 ? Math.max(0, Math.round((netSavings / totalIncome) * 100)) : 0;

  // Filtered List
  const filteredTransactions = React.useMemo(() => {
    return transactions.filter((t) => {
      const matchType = typeFilter === "all" || t.type === typeFilter;
      const matchCat = categoryFilter === "all" || t.category === categoryFilter;
      const matchQuery =
        !searchQuery.trim() ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(t.category).toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.paymentMode.toLowerCase().includes(searchQuery.toLowerCase());
      return matchType && matchCat && matchQuery;
    });
  }, [transactions, typeFilter, categoryFilter, searchQuery]);

  // Handle Manual Save
  const handleSaveTransaction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      toast.error("Please enter a description for this record.");
      return;
    }
    if (amountRupees <= 0) {
      toast.error("Please enter an amount greater than ₹0.");
      return;
    }

    const roundedAmt = Math.round(amountRupees);
    const category = entryType === "income" ? incomeCat : expenseCat;

    const newTxn: PersonalTransaction = {
      id: `tx-${Date.now()}`,
      type: entryType,
      date,
      category,
      description: description.trim(),
      amountRupees: roundedAmt,
      paymentMode,
      bankAccountId: selectedBankId,
    };

    // 1. Update transactions
    const updatedTxns = [newTxn, ...transactions];
    saveTransactions(updatedTxns);
    setTransactions(updatedTxns);

    // 2. Adjust bank account balance if account selected
    if (selectedBankId) {
      const updatedAccounts = bankAccounts.map((acc) => {
        if (acc.id === selectedBankId) {
          const delta = entryType === "income" ? roundedAmt : -roundedAmt;
          return { ...acc, balanceRupees: Math.max(0, acc.balanceRupees + delta) };
        }
        return acc;
      });
      saveBankAccounts(updatedAccounts);
      setBankAccounts(updatedAccounts);
    }

    const typeLabel = entryType === "income" ? "Income" : "Expense";
    toast.success(`Recorded ${typeLabel} of ${rupee(roundedAmt)} (${category})`);

    // Reset Form
    setDialogOpen(false);
    setDescription("");
    setAmountRupees(500);
  };

  const handleDeleteTransaction = (id: string) => {
    const target = transactions.find((t) => t.id === id);
    const updated = transactions.filter((t) => t.id !== id);
    saveTransactions(updated);
    setTransactions(updated);

    // Revert bank account balance if was tied to an account
    if (target && target.bankAccountId) {
      const updatedAccounts = bankAccounts.map((acc) => {
        if (acc.id === target.bankAccountId) {
          const revertDelta = target.type === "income" ? -target.amountRupees : target.amountRupees;
          return { ...acc, balanceRupees: Math.max(0, acc.balanceRupees + revertDelta) };
        }
        return acc;
      });
      saveBankAccounts(updatedAccounts);
      setBankAccounts(updatedAccounts);
    }

    toast.success("Transaction entry removed.");
  };

  const handleExportCSV = () => {
    const headers = ["Date", "Type", "Category", "Description", "Amount (INR)", "Payment Mode"];
    const rows = transactions.map((t) => [
      t.date,
      t.type.toUpperCase(),
      `"${t.category}"`,
      `"${t.description.replace(/"/g, '""')}"`,
      t.amountRupees,
      t.paymentMode,
    ]);
    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `income-and-expenses-${istToday()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Downloaded financial ledger CSV report.");
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Quick Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-2/60 p-4 md:p-5 rounded-xl border border-border">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
              Cash Flow Ledger
            </Badge>
            <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
              Income &amp; Daily Expenses
            </span>
          </div>
          <h2 className="font-serif text-xl md:text-2xl tracking-tight">
            Income &amp; Expenses Ledger
          </h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl">
            Track all incoming salary credits and outgoing daily spends. Add entries manually with a single click or import from bank statements.
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
            onClick={() => {
              setEntryType("expense");
              setDialogOpen(true);
            }}
            className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            Record Entry
          </Button>
        </div>
      </div>

      {/* 3 Summary Badges */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Inflow */}
        <Card className="p-4 border border-emerald-100 bg-emerald-50/20">
          <div className="flex items-center justify-between">
            <span className="text-xs text-emerald-800 font-semibold flex items-center gap-1.5">
              <Icon name="arrow-down-left" size={14} className="text-emerald-600" />
              Total Inflow (Income)
            </span>
            <Badge variant="outline" className="bg-emerald-100 text-emerald-800 text-2xs">
              Credits
            </Badge>
          </div>
          <div className="text-2xl font-serif font-bold text-emerald-700 mt-2 font-mono">
            {rupee(totalIncome)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {transactions.filter((t) => t.type === "income").length} income credits recorded
          </span>
        </Card>

        {/* Total Outflow */}
        <Card className="p-4 border border-rose-100 bg-rose-50/20">
          <div className="flex items-center justify-between">
            <span className="text-xs text-rose-800 font-semibold flex items-center gap-1.5">
              <Icon name="arrow-up-right" size={14} className="text-rose-600" />
              Total Outflow (Spends)
            </span>
            <Badge variant="outline" className="bg-rose-100 text-rose-800 text-2xs">
              Debits
            </Badge>
          </div>
          <div className="text-2xl font-serif font-bold text-rose-700 mt-2 font-mono">
            {rupee(totalExpense)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {transactions.filter((t) => t.type !== "income").length} expense debits recorded
          </span>
        </Card>

        {/* Net Savings & Rate */}
        <Card className="p-4 border border-indigo-100 bg-indigo-50/20">
          <div className="flex items-center justify-between">
            <span className="text-xs text-indigo-900 font-semibold flex items-center gap-1.5">
              <Icon name="wallet" size={14} className="text-indigo-600" />
              Net Monthly Balance
            </span>
            <Badge variant="outline" className="bg-indigo-100 text-indigo-800 text-2xs font-semibold">
              {savingsRatePct}% Savings Rate
            </Badge>
          </div>
          <div className={`text-2xl font-serif font-bold mt-2 font-mono ${netSavings >= 0 ? "text-indigo-950" : "text-rose-600"}`}>
            {rupee(netSavings)}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            {netSavings >= 0 ? "Surplus remaining this month" : "Deficit (spends exceeded income)"}
          </span>
        </Card>
      </div>

      {/* Ledger Table & Filters */}
      <Card className="p-5 border border-border">
        {/* Filter Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-hairline">
          {/* Left: Type Toggle + Search */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Type Filter Buttons */}
            <div className="inline-flex rounded-md border border-hairline bg-paper-2 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTypeFilter("all")}
                className={`px-3 py-1 rounded font-medium transition-all ${
                  typeFilter === "all" ? "bg-white text-ink shadow-2xs" : "text-ink-3 hover:text-ink"
                }`}
              >
                All ({transactions.length})
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter("expense")}
                className={`px-3 py-1 rounded font-medium transition-all ${
                  typeFilter === "expense" ? "bg-white text-rose-700 shadow-2xs" : "text-ink-3 hover:text-ink"
                }`}
              >
                Expenses ({transactions.filter((t) => t.type !== "income").length})
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter("income")}
                className={`px-3 py-1 rounded font-medium transition-all ${
                  typeFilter === "income" ? "bg-white text-emerald-700 shadow-2xs" : "text-ink-3 hover:text-ink"
                }`}
              >
                Income ({transactions.filter((t) => t.type === "income").length})
              </button>
            </div>

            {/* Category Filter */}
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[170px] h-8 text-xs bg-paper">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="Salary">Salary</SelectItem>
                {PERSONAL_EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c.category} value={c.category}>
                    {c.category}
                  </SelectItem>
                ))}
                {PERSONAL_INCOME_CATEGORIES.map((c) => (
                  <SelectItem key={c.category} value={c.category}>
                    {c.category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Search Box */}
            <div className="relative w-48">
              <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ledger..."
                className="pl-8 h-8 text-xs bg-paper"
              />
            </div>
          </div>

          {/* Right: Export and Add */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon="download"
              onClick={handleExportCSV}
              className="text-xs"
            >
              Export CSV
            </Button>
            <Button
              variant="default"
              size="sm"
              icon="plus"
              onClick={() => {
                setEntryType("expense");
                setDialogOpen(true);
              }}
              className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              Record Entry
            </Button>
          </div>
        </div>

        {/* Transaction Rows */}
        <div className="divide-y divide-hairline mt-2">
          {filteredTransactions.length === 0 ? (
            <div className="py-12 text-center">
              <Icon name="inbox" size={32} className="mx-auto text-ink-4 mb-2" />
              <p className="text-sm font-medium text-ink-2">No transaction records found</p>
              <p className="text-xs text-ink-3 mt-1">
                Record an expense or income entry, or import your bank statement.
              </p>
            </div>
          ) : (
            filteredTransactions.map((item) => {
              const isIncome = item.type === "income";
              const expMatch = PERSONAL_EXPENSE_CATEGORIES.find((c) => c.category === item.category);
              const incMatch = PERSONAL_INCOME_CATEGORIES.find((c) => c.category === item.category);
              const iconName = isIncome ? incMatch?.icon || "wallet" : expMatch?.icon || "tag";
              const iconColor = isIncome ? incMatch?.color || "#10B981" : expMatch?.color || "#6366F1";

              return (
                <div
                  key={item.id}
                  className="py-3 px-2 flex items-center justify-between gap-3 hover:bg-paper-2/40 rounded transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Category Icon */}
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 border"
                      style={{
                        backgroundColor: `${iconColor}15`,
                        borderColor: `${iconColor}30`,
                        color: iconColor,
                      }}
                    >
                      <Icon name={iconName} size={16} />
                    </div>

                    {/* Details */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-ink truncate">
                          {item.description}
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-2xs py-0 px-1.5 font-medium ${
                            isIncome
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-paper-2 text-ink-3 border-hairline"
                          }`}
                        >
                          {item.category}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-2xs text-ink-3 mt-0.5">
                        <span>{formatDate(item.date)}</span>
                        <span>•</span>
                        <span>{item.paymentMode}</span>
                        {item.tags && item.tags.length > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-indigo-600">{item.tags.join(", ")}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Amount and Delete */}
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div
                        className={`text-sm font-semibold font-mono ${
                          isIncome ? "text-emerald-600" : "text-ink"
                        }`}
                      >
                        {isIncome ? `+ ${rupee(item.amountRupees)}` : `- ${rupee(item.amountRupees)}`}
                      </div>
                      <span className="text-2xs text-ink-3 block">
                        {isIncome ? "Credit (Income)" : "Debit (Expense)"}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteTransaction(item.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-ink-4 hover:text-rose-600 transition-opacity"
                      title="Delete record"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      {/* Record Entry Modal (Expense or Income) */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-lg">Record Transaction</DialogTitle>
            <DialogDescription className="text-xs">
              Manually add an expense debit or income credit to your personal ledger.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveTransaction} className="space-y-4 py-2">
            {/* Entry Type Toggle: Expense vs Income */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-paper-2 rounded-lg border border-hairline">
              <button
                type="button"
                onClick={() => setEntryType("expense")}
                className={`py-2 px-3 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  entryType === "expense"
                    ? "bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                <Icon name="arrow-up-right" size={14} />
                Expense (खर्च / Debit)
              </button>

              <button
                type="button"
                onClick={() => setEntryType("income")}
                className={`py-2 px-3 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  entryType === "income"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-2xs"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                <Icon name="arrow-down-left" size={14} />
                Income (आमदनी / Credit)
              </button>
            </div>

            {/* Date & Category */}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Date">
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-8 text-xs bg-paper"
                  required
                />
              </FormField>

              <FormField label="Category">
                {entryType === "expense" ? (
                  <Select
                    value={expenseCat}
                    onValueChange={(val) => setExpenseCat(val as PersonalExpenseCategory)}
                  >
                    <SelectTrigger className="h-8 text-xs bg-paper">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERSONAL_EXPENSE_CATEGORIES.map((c) => (
                        <SelectItem key={c.category} value={c.category}>
                          {c.category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={incomeCat}
                    onValueChange={(val) => setIncomeCat(val as PersonalIncomeCategory)}
                  >
                    <SelectTrigger className="h-8 text-xs bg-paper">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERSONAL_INCOME_CATEGORIES.map((c) => (
                        <SelectItem key={c.category} value={c.category}>
                          {c.category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>

            {/* Description */}
            <FormField
              label={entryType === "income" ? "Income Source / Narration" : "Description / Merchant"}
            >
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  entryType === "income"
                    ? "e.g. November In-Hand Salary / Consulting Bonus"
                    : "e.g. Swiggy Food Order / House Rent Transfer"
                }
                className="h-8 text-xs bg-paper"
                required
              />
            </FormField>

            {/* Amount & Bank Account */}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Amount (₹ Whole Rupees)">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={amountRupees || ""}
                  onChange={(e) => setAmountRupees(Number(e.target.value))}
                  placeholder="500"
                  className="h-8 text-xs bg-paper font-mono font-bold"
                  required
                />
              </FormField>

              <FormField label={entryType === "income" ? "Deposit Into Bank" : "Deduct From Bank"}>
                <Select value={selectedBankId} onValueChange={setSelectedBankId}>
                  <SelectTrigger className="h-8 text-xs bg-paper">
                    <SelectValue placeholder="Select bank" />
                  </SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.bankName} (••••{b.accountNumberLast4})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            {/* Payment Mode */}
            <FormField label="Payment Channel">
              <Select
                value={paymentMode}
                onValueChange={(val) => setPaymentMode(val as PersonalTransaction["paymentMode"])}
              >
                <SelectTrigger className="h-8 text-xs bg-paper">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UPI">UPI (GPay / PhonePe / Paytm)</SelectItem>
                  <SelectItem value="Net Banking">Net Banking / NEFT / IMPS</SelectItem>
                  <SelectItem value="Debit Card">Debit Card</SelectItem>
                  <SelectItem value="Credit Card">Credit Card</SelectItem>
                  <SelectItem value="Cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(false)}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className={`text-xs text-white ${
                  entryType === "income"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                Save {entryType === "income" ? "Income Credit" : "Expense Debit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
