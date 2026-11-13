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
import { istToday } from "@/lib/dates/ist";
import { toast } from "sonner";
import {
  type SalariedBankAccount,
  type PersonalTransaction,
  type PersonalExpenseCategory,
  type PersonalIncomeCategory,
  PERSONAL_EXPENSE_CATEGORIES,
  PERSONAL_INCOME_CATEGORIES,
  loadBankAccounts,
  saveBankAccounts,
  loadTransactions,
  saveTransactions,
  STORAGE_BANKS_KEY,
} from "@/lib/employee-hub/personal-finance-store";

interface Props {
  onExpensesImported: (newTxns: PersonalTransaction[]) => void;
  onNavigateToExpenses: () => void;
}

export interface ParsedBankTxn {
  id: string;
  date: string;
  narration: string;
  debit: number;
  credit: number;
  balance: number | null;
  type: "expense" | "income";
  detectedCategory: string;
  isSalary: boolean;
  selected: boolean;
}

const SAMPLE_HDFC_CSV = `Date,Narration,Chq/Ref No,Withdrawal (Dr),Deposit (Cr),Closing Balance
01/11/2026,NEFT CR-ANUTECH DIGITAL-SALARY-NOV26,CMS10982341,,85000,118500
01/11/2026,UPI-RENT PAYMENT TO SURESH KUMAR-PAYTM,UPI99218273,22000,,96500
02/11/2026,ACH DEBIT-HDFC LIFE INSURANCE ANNUAL PREM,ACH881239,12500,,84000
03/11/2026,POS-DMART SUPERMARKET WHITEFIELD BLR,POS448102,6450,,77550
04/11/2026,UPI-SWIGGY FOOD ORDER BANGALORE,UPI88129011,840,,76710
05/11/2026,BILLDESK-AIRTEL XSTREAM FIBER BROADBAND,BIL771239,1179,,75531
06/11/2026,POS-HPCL PETROL BUNK AIRPORT ROAD,POS901238,3500,,72031
07/11/2026,UPI-BLINKIT GROCERY INSTANT 10MIN,UPI661209,560,,71471
08/11/2026,E-COMM-AMAZON PAY INDIA APPAREL & BOOKS,ECOM11029,2499,,68972
10/11/2026,UPI-UBER RIDE CLIENT MEETING KORAMANGALA,UPI441920,640,,68332`;

// Indian banking statement parser heuristic
function categorizeNarration(narration: string, debit: number, credit: number): {
  cat: string;
  type: "expense" | "income";
  isSalary: boolean;
} {
  const norm = narration.toUpperCase();

  if (credit > 0) {
    if (norm.includes("SALARY") || norm.includes("PAYROLL") || norm.includes("CMS") || credit >= 30000) {
      return { cat: "Salary", type: "income", isSalary: true };
    }
    if (norm.includes("DIVIDEND") || norm.includes("INTR") || norm.includes("INTEREST")) {
      return { cat: "Interest & Dividends", type: "income", isSalary: false };
    }
    if (norm.includes("REFUND") || norm.includes("CASHBACK") || norm.includes("REVERSAL")) {
      return { cat: "Refund & Cashback", type: "income", isSalary: false };
    }
    if (norm.includes("BONUS") || norm.includes("INCENTIVE")) {
      return { cat: "Bonus / Incentive", type: "income", isSalary: false };
    }
    return { cat: "Other Income", type: "income", isSalary: false };
  }

  if (debit > 0) {
    if (norm.includes("RENT") || norm.includes("LANDLORD") || norm.includes("MAINTENANCE")) {
      return { cat: "Housing & Rent", type: "expense", isSalary: false };
    }
    if (
      norm.includes("SWIGGY") ||
      norm.includes("ZOMATO") ||
      norm.includes("DMART") ||
      norm.includes("BLINKIT") ||
      norm.includes("ZEPTO") ||
      norm.includes("BIGBASKET") ||
      norm.includes("INSTAMART")
    ) {
      return { cat: "Food & Groceries", type: "expense", isSalary: false };
    }
    if (
      norm.includes("PETROL") ||
      norm.includes("HPCL") ||
      norm.includes("BPCL") ||
      norm.includes("IOCL") ||
      norm.includes("UBER") ||
      norm.includes("OLA") ||
      norm.includes("FASTAG") ||
      norm.includes("METRO")
    ) {
      return { cat: "Fuel & Commute", type: "expense", isSalary: false };
    }
    if (
      norm.includes("AIRTEL") ||
      norm.includes("JIO") ||
      norm.includes("BILLDESK") ||
      norm.includes("DISCOM") ||
      norm.includes("ELECTRIC") ||
      norm.includes("BESCOM") ||
      norm.includes("TATA POWER")
    ) {
      return { cat: "Utilities & Bills", type: "expense", isSalary: false };
    }
    if (norm.includes("AMAZON") || norm.includes("FLIPKART") || norm.includes("MYNTRA") || norm.includes("ECOM")) {
      return { cat: "Shopping & Lifestyle", type: "expense", isSalary: false };
    }
    if (
      norm.includes("NETFLIX") ||
      norm.includes("SPOTIFY") ||
      norm.includes("PRIME") ||
      norm.includes("HOTSTAR") ||
      norm.includes("YOUTUBE")
    ) {
      return { cat: "Subscriptions & OTT", type: "expense", isSalary: false };
    }
    if (
      norm.includes("APOLLO") ||
      norm.includes("1MG") ||
      norm.includes("PHARMACY") ||
      norm.includes("HOSPITAL") ||
      norm.includes("PRACTO")
    ) {
      return { cat: "Health & Medical", type: "expense", isSalary: false };
    }
    if (
      norm.includes("EMI") ||
      norm.includes("LOAN") ||
      norm.includes("INSURANCE") ||
      norm.includes("HDFC LIFE") ||
      norm.includes("LIC")
    ) {
      return { cat: "EMI & Loans", type: "expense", isSalary: false };
    }
    if (
      norm.includes("CAFE") ||
      norm.includes("RESTAURANT") ||
      norm.includes("PVR") ||
      norm.includes("INOX") ||
      norm.includes("BAR")
    ) {
      return { cat: "Entertainment & Dining", type: "expense", isSalary: false };
    }
  }

  return { cat: debit > 0 ? "Miscellaneous" : "Other Income", type: debit > 0 ? "expense" : "income", isSalary: false };
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      values.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  values.push(cur.trim());
  return values;
}

export function BankAccountsSection({ onExpensesImported, onNavigateToExpenses }: Props) {
  const [accounts, setAccounts] = React.useState<SalariedBankAccount[]>(loadBankAccounts);
  const [selectedBankId, setSelectedBankId] = React.useState<string>("acc-hdfc");

  // Statement Parsing State
  const [csvText, setCsvText] = React.useState<string>("");
  const [parsedRows, setParsedRows] = React.useState<ParsedBankTxn[]>([]);
  const [fileName, setFileName] = React.useState<string>("");

  // Account Dialogs
  const [addAccountOpen, setAddAccountOpen] = React.useState(false);
  const [editBalanceOpen, setEditBalanceOpen] = React.useState(false);
  const [editingAccountId, setEditingAccountId] = React.useState<string | null>(null);
  const [updatedBalance, setUpdatedBalance] = React.useState<string>("");

  // New Account Form
  const [newBankName, setNewBankName] = React.useState<string>("HDFC Bank");
  const [newAccountType, setNewAccountType] = React.useState<SalariedBankAccount["accountType"]>("Daily UPI / Savings");
  const [newLast4, setNewLast4] = React.useState<string>("");
  const [newInitialBalance, setNewInitialBalance] = React.useState<string>("25000");

  // Sync with global store changes
  React.useEffect(() => {
    const handleSync = () => {
      setAccounts(loadBankAccounts());
    };
    window.addEventListener("salaried_pro_banks_updated", handleSync);
    return () => window.removeEventListener("salaried_pro_banks_updated", handleSync);
  }, []);

  const totalBalance = React.useMemo(() => {
    return accounts.reduce((sum, a) => sum + a.balanceRupees, 0);
  }, [accounts]);

  const saveAndSync = (newAccounts: SalariedBankAccount[]) => {
    setAccounts(newAccounts);
    saveBankAccounts(newAccounts);
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLast4.trim() || newLast4.length !== 4) {
      toast.error("Please enter the last 4 digits of your account number.");
      return;
    }

    const bal = Math.round(parseFloat(newInitialBalance.replace(/[^\d.-]/g, "")) || 0);

    const newAcc: SalariedBankAccount = {
      id: `acc-${Date.now()}`,
      bankName: newBankName,
      accountType: newAccountType,
      accountNumberLast4: newLast4.trim(),
      balanceRupees: bal,
      isPrimarySalary: newAccountType === "Salary Account",
    };

    const updated = [...accounts, newAcc];
    saveAndSync(updated);
    toast.success(`Added ${newBankName} account successfully!`);
    setAddAccountOpen(false);
    setNewLast4("");
  };

  const handleSaveBalance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccountId) return;

    const bal = Math.round(parseFloat(updatedBalance.replace(/[^\d.-]/g, "")) || 0);
    const updated = accounts.map((a) => (a.id === editingAccountId ? { ...a, balanceRupees: bal } : a));
    saveAndSync(updated);
    toast.success("Bank balance updated.");
    setEditBalanceOpen(false);
    setEditingAccountId(null);
  };

  // CSV Parsing
  const handleParseCsv = (content: string, name?: string) => {
    try {
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length < 2) {
        toast.error("CSV file is empty or does not contain enough rows.");
        return;
      }

      const rows: ParsedBankTxn[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < 4) continue;

        const dateStr = cols[0] || istToday();
        const narration = cols[1] || "Transaction";
        const debit = parseFloat(cols[3]?.replace(/[^\d.-]/g, "") || "0") || 0;
        const credit = parseFloat(cols[4]?.replace(/[^\d.-]/g, "") || "0") || 0;
        const balance = cols[5] ? parseFloat(cols[5].replace(/[^\d.-]/g, "") || "0") : null;

        if (debit <= 0 && credit <= 0) continue;

        const { cat, type, isSalary } = categorizeNarration(narration, debit, credit);

        rows.push({
          id: `txn-${Date.now()}-${i}`,
          date: dateStr.includes("/") ? dateStr.split("/").reverse().join("-") : dateStr,
          narration,
          debit: Math.round(debit),
          credit: Math.round(credit),
          balance: balance !== null ? Math.round(balance) : null,
          type,
          detectedCategory: cat,
          isSalary,
          selected: true,
        });
      }

      setParsedRows(rows);
      setFileName(name || "statement.csv");
      toast.success(`Successfully parsed ${rows.length} transactions from bank statement!`);
    } catch {
      toast.error("Failed to parse statement format. Please check CSV.");
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        setCsvText(text);
        handleParseCsv(text, file.name);
      }
    };
    reader.readAsText(file);
  };

  // Import parsed rows into user's ledger (both Income and Expense) and adjust bank balance
  const handleImportToLedger = () => {
    const selectedRows = parsedRows.filter((r) => r.selected);
    if (selectedRows.length === 0) {
      toast.error("Please select at least one transaction to import.");
      return;
    }

    const newTxns: PersonalTransaction[] = [];
    let netDebitTotal = 0;
    let netCreditTotal = 0;
    let debitCount = 0;
    let creditCount = 0;

    for (const r of selectedRows) {
      if (r.credit > 0) {
        newTxns.push({
          id: `tx-stmt-cr-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          type: "income",
          date: r.date,
          category: r.detectedCategory,
          description: r.narration,
          amountRupees: r.credit,
          paymentMode: "Net Banking",
          bankAccountId: selectedBankId,
          tags: ["Bank Statement", "Credit"],
        });
        netCreditTotal += r.credit;
        creditCount++;
      } else if (r.debit > 0) {
        newTxns.push({
          id: `tx-stmt-dr-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          type: "expense",
          date: r.date,
          category: r.detectedCategory,
          description: r.narration,
          amountRupees: r.debit,
          paymentMode: "UPI",
          bankAccountId: selectedBankId,
          tags: ["Bank Statement"],
        });
        netDebitTotal += r.debit;
        debitCount++;
      }
    }

    // 1. Update target bank balance
    const targetAcc = accounts.find((a) => a.id === selectedBankId) || accounts[0];
    if (targetAcc) {
      const netChange = netCreditTotal - netDebitTotal;
      const updatedBalance = Math.max(0, targetAcc.balanceRupees + netChange);
      const updatedAccounts = accounts.map((a) => (a.id === targetAcc.id ? { ...a, balanceRupees: updatedBalance } : a));
      saveAndSync(updatedAccounts);
    }

    // 2. Save transactions to ledger store
    const existing = loadTransactions();
    const combined = [...newTxns, ...existing];
    saveTransactions(combined);
    onExpensesImported(newTxns);

    toast.success(
      `Imported ${creditCount} income credits (+${rupee(netCreditTotal)}) and ${debitCount} expense debits (-${rupee(netDebitTotal)}) into your ledger!`
    );

    // Clear preview
    setParsedRows([]);
    setCsvText("");
  };

  return (
    <div className="space-y-6">
      {/* Top Bank Accounts Overview */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-3 border-b border-hairline">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink">My Bank Accounts</h2>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
              Total Balance: {rupee(totalBalance)}
            </Badge>
          </div>
          <p className="text-xs text-ink-3 mt-0.5">
            Manage your salary account and daily UPI accounts with 1-click statement sync.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddAccountOpen(true)}
          className="gap-1.5"
        >
          <Icon name="plus" size={14} />
          + Add Bank Account
        </Button>
      </div>

      {/* Account Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {accounts.map((acc) => (
          <Card
            key={acc.id}
            className={`p-4 border-2 transition-all cursor-pointer ${
              selectedBankId === acc.id
                ? "border-indigo-500 bg-indigo-50/20 shadow-sm"
                : "border-hairline bg-paper hover:bg-paper-2/40"
            }`}
            onClick={() => setSelectedBankId(acc.id)}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink flex items-center gap-1.5">
                <Icon name="building" size={14} className="text-indigo-600" />
                {acc.bankName}
              </span>
              <span className="text-2xs font-mono text-ink-3">••••{acc.accountNumberLast4}</span>
            </div>

            <div className="text-2xl font-serif font-bold text-ink mt-3 font-mono">
              {rupee(acc.balanceRupees)}
            </div>

            <div className="flex items-center justify-between mt-2 pt-2 border-t border-hairline text-2xs">
              <span className="text-ink-3">{acc.accountType}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingAccountId(acc.id);
                  setUpdatedBalance(String(acc.balanceRupees));
                  setEditBalanceOpen(true);
                }}
                className="text-indigo-600 hover:underline font-medium"
              >
                Edit Balance
              </button>
            </div>
          </Card>
        ))}
      </div>

      {/* Bank Statement Importer Card */}
      <Card className="p-6 border-2 border-indigo-100 bg-gradient-to-br from-paper to-indigo-50/10 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-hairline pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                1-Click Bank Statement Import
              </span>
              <span className="text-xs text-ink-3">HDFC, SBI, ICICI, Axis, Kotak</span>
            </div>
            <h3 className="text-lg font-serif font-bold text-ink mt-1">
              Import Statement into{" "}
              <span className="text-indigo-600">
                {accounts.find((a) => a.id === selectedBankId)?.bankName || "Selected Account"}
              </span>
            </h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Upload your bank statement CSV. The system auto-categorizes both Income (Salary credits) and Expenses (UPI/debits), and automatically updates your balance.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCsvText(SAMPLE_HDFC_CSV);
                handleParseCsv(SAMPLE_HDFC_CSV, "sample-hdfc-statement.csv");
              }}
              className="gap-1.5 text-xs text-indigo-700 border-indigo-200 bg-white hover:bg-indigo-50"
            >
              <Icon name="play" size={14} />
              Load Sample Statement (1-Click Test)
            </Button>
          </div>
        </div>

        {/* Upload Dropzone */}
        <div className="border-2 border-dashed border-indigo-200 rounded-xl p-6 text-center bg-white/60 hover:bg-white transition-all">
          <input
            type="file"
            id="statement-upload"
            accept=".csv,text/csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <label htmlFor="statement-upload" className="cursor-pointer block space-y-2">
            <div className="w-12 h-12 mx-auto rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Icon name="upload-cloud" size={24} />
            </div>
            <div>
              <span className="text-sm font-semibold text-indigo-600 hover:underline">
                Click to upload Bank CSV Statement
              </span>
              <span className="text-sm text-ink-3"> or drag and drop</span>
            </div>
            <p className="text-2xs text-ink-3">
              Standard Indian Net Banking CSV exports (Date, Narration, Ref, Debit, Credit, Balance)
            </p>
          </label>
        </div>

        {/* Parsed Statement Preview Table */}
        {parsedRows.length > 0 && (
          <div className="space-y-3 pt-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink">
                  Parsed {parsedRows.length} transactions from {fileName}
                </span>
                <span className="text-2xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  {parsedRows.filter((r) => r.selected).length} selected
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setParsedRows([])}
                  className="text-xs h-8"
                >
                  Clear
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleImportToLedger}
                  className="gap-1.5 text-xs h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Icon name="check" size={14} />
                  Import Selected to Ledger &amp; Balance
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto border border-hairline rounded-lg max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-paper-2 text-ink-3 font-semibold uppercase tracking-wider text-2xs sticky top-0 border-b border-hairline">
                  <tr>
                    <th className="p-3 w-8">
                      <input
                        type="checkbox"
                        checked={parsedRows.every((r) => r.selected)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setParsedRows(parsedRows.map((r) => ({ ...r, selected: checked })));
                        }}
                      />
                    </th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Narration / UPI Payee</th>
                    <th className="p-3">Auto-Detected Category</th>
                    <th className="p-3 text-right">Debit (Expense ₹)</th>
                    <th className="p-3 text-right">Credit (Income ₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline bg-paper">
                  {parsedRows.map((r, idx) => (
                    <tr
                      key={r.id}
                      className={`hover:bg-paper-2/40 transition-colors ${
                        r.selected ? "bg-white" : "opacity-50"
                      }`}
                    >
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={r.selected}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setParsedRows(
                              parsedRows.map((row, i) => (i === idx ? { ...row, selected: checked } : row))
                            );
                          }}
                        />
                      </td>
                      <td className="p-3 font-mono text-ink-2 whitespace-nowrap">{r.date}</td>
                      <td className="p-3">
                        <div className="font-medium text-ink">{r.narration}</div>
                        {r.isSalary ? (
                          <span className="text-2xs font-semibold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800">
                            Monthly Salary Credit
                          </span>
                        ) : r.credit > 0 ? (
                          <span className="text-2xs font-semibold px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700">
                            Income Inflow
                          </span>
                        ) : null}
                      </td>
                      <td className="p-3">
                        <select
                          value={r.detectedCategory}
                          onChange={(e) => {
                            const val = e.target.value;
                            setParsedRows(
                              parsedRows.map((row, i) => (i === idx ? { ...row, detectedCategory: val } : row))
                            );
                          }}
                          className="px-2 py-1 text-xs border rounded border-hairline bg-paper text-ink"
                        >
                          {r.credit > 0 ? (
                            PERSONAL_INCOME_CATEGORIES.map((c) => (
                              <option key={c.category} value={c.category}>
                                {c.category}
                              </option>
                            ))
                          ) : (
                            PERSONAL_EXPENSE_CATEGORIES.map((c) => (
                              <option key={c.category} value={c.category}>
                                {c.category}
                              </option>
                            ))
                          )}
                        </select>
                      </td>
                      <td className="p-3 text-right font-mono font-semibold text-rose-600">
                        {r.debit > 0 ? rupee(r.debit) : "—"}
                      </td>
                      <td className="p-3 text-right font-mono font-semibold text-emerald-600">
                        {r.credit > 0 ? rupee(r.credit) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* Add Bank Account Dialog */}
      <Dialog open={addAccountOpen} onOpenChange={setAddAccountOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Bank Account</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleAddAccount} className="space-y-4 text-xs pt-2">
            <div>
              <label className="font-medium text-ink block mb-1">Bank Name</label>
              <select
                value={newBankName}
                onChange={(e) => setNewBankName(e.target.value)}
                className="w-full px-3 py-2 border rounded border-hairline bg-paper"
              >
                <option value="HDFC Bank">HDFC Bank</option>
                <option value="State Bank of India (SBI)">State Bank of India (SBI)</option>
                <option value="ICICI Bank">ICICI Bank</option>
                <option value="Axis Bank">Axis Bank</option>
                <option value="Kotak Mahindra Bank">Kotak Mahindra Bank</option>
                <option value="Punjab National Bank">Punjab National Bank</option>
                <option value="Bank of Baroda">Bank of Baroda</option>
              </select>
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Account Purpose</label>
              <select
                value={newAccountType}
                onChange={(e) => setNewAccountType(e.target.value as SalariedBankAccount["accountType"])}
                className="w-full px-3 py-2 border rounded border-hairline bg-paper"
              >
                <option value="Salary Account">Salary Account (Primary Salary Credit)</option>
                <option value="Daily UPI / Savings">Daily UPI / Savings</option>
                <option value="Emergency Fund">Emergency Fund</option>
              </select>
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Account Number (Last 4 Digits)</label>
              <Input
                maxLength={4}
                value={newLast4}
                onChange={(e) => setNewLast4(e.target.value.replace(/\D/g, ""))}
                placeholder="4892"
                className="h-8 text-xs font-mono"
                required
              />
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Current Balance (₹ Whole Rupees)</label>
              <Input
                type="number"
                value={newInitialBalance}
                onChange={(e) => setNewInitialBalance(e.target.value)}
                placeholder="50000"
                className="h-8 text-xs font-mono font-bold"
                required
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setAddAccountOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Save Account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Balance Dialog */}
      <Dialog open={editBalanceOpen} onOpenChange={setEditBalanceOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Update Account Balance</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSaveBalance} className="space-y-4 text-xs pt-2">
            <div>
              <label className="font-medium text-ink block mb-1">Current Balance (₹)</label>
              <Input
                type="number"
                value={updatedBalance}
                onChange={(e) => setUpdatedBalance(e.target.value)}
                placeholder="100000"
                className="h-9 text-sm font-mono font-bold"
                required
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditBalanceOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Update Balance
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
