"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { rupee } from "@/lib/utils";
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
} from "@/lib/employee-hub/personal-finance-store";

export interface RecordTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: TransactionType;
  onSuccess?: () => void;
}

export function RecordTransactionDialog({
  open,
  onOpenChange,
  defaultType = "expense",
  onSuccess,
}: RecordTransactionDialogProps) {
  const [bankAccounts, setBankAccounts] = React.useState<SalariedBankAccount[]>(loadBankAccounts);
  const [entryType, setEntryType] = React.useState<TransactionType>(defaultType);
  const [date, setDate] = React.useState<string>(istToday());
  const [expenseCat, setExpenseCat] = React.useState<PersonalExpenseCategory>("Food & Groceries");
  const [incomeCat, setIncomeCat] = React.useState<PersonalIncomeCategory>("Salary");
  const [description, setDescription] = React.useState<string>("");
  const [amountRupees, setAmountRupees] = React.useState<number>(500);
  const [paymentMode, setPaymentMode] = React.useState<PersonalTransaction["paymentMode"]>("UPI");
  const [selectedBankId, setSelectedBankId] = React.useState<string>("acc-hdfc");

  // Keep entryType in sync when defaultType changes or modal opens
  React.useEffect(() => {
    if (open) {
      setEntryType(defaultType);
      setBankAccounts(loadBankAccounts());
      setDate(istToday());
      if (defaultType === "income") {
        setAmountRupees(50000);
        setDescription("Monthly Salary Credit");
      } else {
        setAmountRupees(500);
        setDescription("");
      }
    }
  }, [open, defaultType]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!amountRupees || amountRupees <= 0) {
      toast.error("Please enter a valid amount in whole Rupees (₹)");
      return;
    }
    if (!description.trim()) {
      toast.error("Please enter a description or merchant name");
      return;
    }

    const roundedAmount = Math.round(amountRupees);
    const chosenCategory = entryType === "income" ? incomeCat : expenseCat;

    const newTxn: PersonalTransaction = {
      id: "ptxn-" + Date.now(),
      type: entryType,
      date,
      category: chosenCategory,
      description: description.trim(),
      amountRupees: roundedAmount,
      paymentMode,
      bankAccountId: selectedBankId,
    };

    // 1. Save Transaction to local ledger
    const currentTxns = loadTransactions();
    const updatedTxns = [newTxn, ...currentTxns];
    saveTransactions(updatedTxns);

    // 2. Adjust Bank Account Balance if bank selected
    if (selectedBankId) {
      const currentBanks = loadBankAccounts();
      const updatedBanks = currentBanks.map((acc) => {
        if (acc.id === selectedBankId) {
          const delta = entryType === "income" ? roundedAmount : -roundedAmount;
          return {
            ...acc,
            balanceRupees: Math.max(0, acc.balanceRupees + delta),
          };
        }
        return acc;
      });
      saveBankAccounts(updatedBanks);
    }

    toast.success(
      entryType === "income"
        ? `Income of ${rupee(roundedAmount)} credited to ${chosenCategory}!`
        : `Expense of ${rupee(roundedAmount)} recorded under ${chosenCategory}!`
    );

    onOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                entryType === "income"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-indigo-100 text-indigo-700"
              }`}
            >
              <Icon name={entryType === "income" ? "wallet" : "plus"} size={16} />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">
                Record Financial Entry
              </DialogTitle>
              <DialogDescription className="text-xs text-ink-3">
                Track your personal income credits or daily expense debits.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {/* Top Toggle: Expense vs Income */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-paper-2 rounded-lg border border-hairline">
            <button
              type="button"
              onClick={() => {
                setEntryType("expense");
                if (amountRupees > 10000) setAmountRupees(500);
              }}
              className={`py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                entryType === "expense"
                  ? "bg-white text-rose-700 border border-rose-200 shadow-2xs"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              <Icon name="tag" size={14} className="text-rose-600" />
              Expense (खर्च / Debit)
            </button>
            <button
              type="button"
              onClick={() => {
                setEntryType("income");
                if (amountRupees < 1000) setAmountRupees(50000);
              }}
              className={`py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                entryType === "income"
                  ? "bg-white text-emerald-700 border border-emerald-200 shadow-2xs"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              <Icon name="wallet" size={14} className="text-emerald-600" />
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

          {/* Description / Narration */}
          <FormField
            label={entryType === "income" ? "Income Source / Narration" : "Description / Merchant"}
          >
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                entryType === "income"
                  ? "e.g. Monthly In-Hand Salary / Consulting Bonus"
                  : "e.g. Swiggy Food Delivery / Flat Rent / Petrol"
              }
              className="h-8 text-xs bg-paper"
              required
            />
          </FormField>

          {/* Amount & Bank Account */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount (₹ Whole Rupees)">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-3">
                  ₹
                </span>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={amountRupees || ""}
                  onChange={(e) => setAmountRupees(Number(e.target.value))}
                  placeholder="500"
                  className="pl-6 h-8 text-xs bg-paper font-mono font-bold"
                  required
                />
              </div>
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

          {/* Payment Channel */}
          <FormField label="Payment Mode">
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

          <DialogFooter className="pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
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
              <Icon name="check" size={14} className="mr-1" />
              Save {entryType === "income" ? "Income Credit" : "Expense Spend"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
