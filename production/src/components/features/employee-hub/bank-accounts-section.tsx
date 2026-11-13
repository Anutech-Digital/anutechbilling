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
  loadBankAccounts,
  saveBankAccounts,
  STORAGE_BANKS_KEY,
} from "@/lib/employee-hub/personal-finance-store";
import {
  type PersonalExpense,
  type PersonalExpenseCategory,
  PERSONAL_EXPENSE_CATEGORIES,
} from "./personal-expenses-section";

interface Props {
  onExpensesImported: (newExpenses: PersonalExpense[]) => void;
  onNavigateToExpenses: () => void;
}

export interface ParsedBankTxn {
  id: string;
  date: string;
  narration: string;
  debit: number;
  credit: number;
  balance: number | null;
  detectedCategory: PersonalExpenseCategory | "Salary Income";
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
  cat: PersonalExpenseCategory | "Salary Income";
  isSalary: boolean;
} {
  const norm = narration.toUpperCase();

  if (credit > 0 && (norm.includes("SALARY") || norm.includes("PAYROLL") || norm.includes("CMS") || credit >= 30000)) {
    return { cat: "Salary Income", isSalary: true };
  }

  if (debit > 0) {
    if (norm.includes("RENT") || norm.includes("LANDLORD") || norm.includes("MAINTENANCE")) {
      return { cat: "Housing & Rent", isSalary: false };
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
      return { cat: "Food & Groceries", isSalary: false };
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
      return { cat: "Fuel & Commute", isSalary: false };
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
      return { cat: "Utilities & Bills", isSalary: false };
    }
    if (norm.includes("AMAZON") || norm.includes("FLIPKART") || norm.includes("MYNTRA") || norm.includes("ECOM")) {
      return { cat: "Shopping & Lifestyle", isSalary: false };
    }
    if (
      norm.includes("NETFLIX") ||
      norm.includes("SPOTIFY") ||
      norm.includes("PRIME") ||
      norm.includes("HOTSTAR") ||
      norm.includes("YOUTUBE")
    ) {
      return { cat: "Subscriptions & OTT", isSalary: false };
    }
    if (
      norm.includes("APOLLO") ||
      norm.includes("1MG") ||
      norm.includes("PHARMACY") ||
      norm.includes("HOSPITAL") ||
      norm.includes("PRACTO")
    ) {
      return { cat: "Health & Medical", isSalary: false };
    }
    if (
      norm.includes("EMI") ||
      norm.includes("LOAN") ||
      norm.includes("INSURANCE") ||
      norm.includes("HDFC LIFE") ||
      norm.includes("LIC")
    ) {
      return { cat: "EMI & Loans", isSalary: false };
    }
    if (
      norm.includes("CAFE") ||
      norm.includes("RESTAURANT") ||
      norm.includes("PVR") ||
      norm.includes("INOX") ||
      norm.includes("BAR")
    ) {
      return { cat: "Entertainment & Dining", isSalary: false };
    }
  }

  return { cat: debit > 0 ? "Miscellaneous" : "Salary Income", isSalary: credit > 0 };
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
  const [selectedBankId, setSelectedBankId] = React.useState<string>(accounts[0]?.id || "acc-hdfc");

  // Add Account Modal
  const [addAccountOpen, setAddAccountOpen] = React.useState(false);
  const [newBankName, setNewBankName] = React.useState("HDFC Bank");
  const [newAccountType, setNewAccountType] = React.useState<SalariedBankAccount["accountType"]>("Salary Account");
  const [newLast4, setNewLast4] = React.useState("");
  const [newBalance, setNewBalance] = React.useState("");

  // Edit Balance Modal
  const [editBalanceOpen, setEditBalanceOpen] = React.useState(false);
  const [editingAccountId, setEditingAccountId] = React.useState<string | null>(null);
  const [updatedBalance, setUpdatedBalance] = React.useState("");

  // Statement Parser State
  const [csvText, setCsvText] = React.useState("");
  const [parsedRows, setParsedRows] = React.useState<ParsedBankTxn[]>([]);
  const [fileName, setFileName] = React.useState<string>("");

  // Total balance across accounts
  const totalBalance = React.useMemo(() => {
    return accounts.reduce((sum, a) => sum + a.balanceRupees, 0);
  }, [accounts]);

  const saveAndSync = (updated: SalariedBankAccount[]) => {
    setAccounts(updated);
    saveBankAccounts(updated);
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBankName.trim() || !newLast4.trim()) {
      toast.error("Please fill in bank name and last 4 digits.");
      return;
    }
    const bal = parseInt(newBalance, 10) || 0;
    const newAcc: SalariedBankAccount = {
      id: `acc-${Date.now()}`,
      bankName: newBankName.trim(),
      accountType: newAccountType,
      accountNumberLast4: newLast4.slice(-4),
      balanceRupees: Math.max(0, bal),
      isPrimarySalary: accounts.length === 0 || newAccountType === "Salary Account",
    };
    const updated = [...accounts, newAcc];
    saveAndSync(updated);
    setAddAccountOpen(false);
    setNewLast4("");
    setNewBalance("");
    toast.success(`Added ${newAcc.bankName} (••••${newAcc.accountNumberLast4})`);
  };

  const handleUpdateBalance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccountId) return;
    const bal = parseInt(updatedBalance, 10);
    if (isNaN(bal) || bal < 0) {
      toast.error("Please enter a valid balance.");
      return;
    }
    const updated = accounts.map((a) => (a.id === editingAccountId ? { ...a, balanceRupees: bal } : a));
    saveAndSync(updated);
    setEditBalanceOpen(false);
    setEditingAccountId(null);
    toast.success("Bank account balance updated.");
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

        const { cat, isSalary } = categorizeNarration(narration, debit, credit);

        rows.push({
          id: `txn-${Date.now()}-${i}`,
          date: dateStr.includes("/") ? dateStr.split("/").reverse().join("-") : dateStr,
          narration,
          debit: Math.round(debit),
          credit: Math.round(credit),
          balance: balance !== null ? Math.round(balance) : null,
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

  // Import parsed rows into user's expenses and adjust bank balance
  const handleImportToLedger = () => {
    const selectedRows = parsedRows.filter((r) => r.selected);
    if (selectedRows.length === 0) {
      toast.error("Please select at least one transaction to import.");
      return;
    }

    const newExpenses: PersonalExpense[] = [];
    let netDebitTotal = 0;
    let netCreditTotal = 0;

    for (const r of selectedRows) {
      if (r.debit > 0) {
        newExpenses.push({
          id: `pe-stmt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          date: r.date,
          category: (r.detectedCategory === "Salary Income" ? "Miscellaneous" : r.detectedCategory) as PersonalExpenseCategory,
          description: r.narration,
          amountRupees: r.debit,
          paymentMode: "UPI",
          tags: ["Bank Statement"],
        });
        netDebitTotal += r.debit;
      } else if (r.credit > 0) {
        netCreditTotal += r.credit;
      }
    }

    // Update target bank balance
    const targetAcc = accounts.find((a) => a.id === selectedBankId) || accounts[0];
    if (targetAcc) {
      const netChange = netCreditTotal - netDebitTotal;
      const updatedBalance = Math.max(0, targetAcc.balanceRupees + netChange);
      const updatedAccounts = accounts.map((a) => (a.id === targetAcc.id ? { ...a, balanceRupees: updatedBalance } : a));
      saveAndSync(updatedAccounts);
    }

    // Save expenses
    onExpensesImported(newExpenses);

    toast.success(
      `Imported ${newExpenses.length} expenses to ledger! Bank balance updated (+${rupee(netCreditTotal)}, -${rupee(netDebitTotal)}).`
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
              Upload your bank statement CSV. The system auto-categorizes UPI spends and updates your ledger and bank balance.
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

        {/* Upload Box */}
        {parsedRows.length === 0 ? (
          <div className="border-2 border-dashed border-indigo-200 rounded-lg p-8 text-center space-y-3 bg-white/70">
            <div className="w-12 h-12 rounded-full bg-indigo-50 text-indigo-600 mx-auto flex items-center justify-center">
              <Icon name="upload_cloud" size={24} />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">Drag and drop your Bank Statement (.csv)</p>
              <p className="text-xs text-ink-3 mt-0.5">
                Download your monthly statement from HDFC NetBanking, SBI Yono, or ICICI iMobile as CSV
              </p>
            </div>
            <div className="pt-2">
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-indigo-600 text-white text-xs font-medium cursor-pointer hover:bg-indigo-700 transition-colors">
                <Icon name="file" size={14} />
                Browse CSV File
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : (
          /* Parsed Rows Preview Table */
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-indigo-50/60 p-3 rounded-md border border-indigo-100">
              <div className="flex items-center gap-2">
                <Icon name="check" size={16} className="text-emerald-600" />
                <span className="text-xs font-semibold text-ink">
                  {fileName} ({parsedRows.length} transactions detected)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setParsedRows([]);
                    setCsvText("");
                  }}
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
                    <th className="p-3 text-right">Debit (₹)</th>
                    <th className="p-3 text-right">Credit (₹)</th>
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
                        {r.isSalary && (
                          <span className="text-2xs font-semibold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800">
                            Monthly Salary Credit
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <select
                          value={r.detectedCategory}
                          onChange={(e) => {
                            const val = e.target.value as PersonalExpenseCategory;
                            setParsedRows(
                              parsedRows.map((row, i) => (i === idx ? { ...row, detectedCategory: val } : row))
                            );
                          }}
                          className="px-2 py-1 text-xs border rounded border-hairline bg-paper text-ink"
                        >
                          {r.isSalary && <option value="Salary Income">Salary Income</option>}
                          {PERSONAL_EXPENSE_CATEGORIES.map((c) => (
                            <option key={c.category} value={c.category}>
                              {c.category}
                            </option>
                          ))}
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
                <option value="Other Bank">Other Bank</option>
              </select>
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Account Purpose</label>
              <select
                value={newAccountType}
                onChange={(e) => setNewAccountType(e.target.value as SalariedBankAccount["accountType"])}
                className="w-full px-3 py-2 border rounded border-hairline bg-paper"
              >
                <option value="Salary Account">Salary Account (Primary Income)</option>
                <option value="Daily UPI / Savings">Daily UPI / Living Expenses</option>
                <option value="Emergency Fund">Emergency Fund / Savings Buffer</option>
              </select>
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Account Number (Last 4 Digits)</label>
              <Input
                type="text"
                placeholder="4892"
                maxLength={4}
                value={newLast4}
                onChange={(e) => setNewLast4(e.target.value.replace(/\D/g, ""))}
                className="font-mono"
              />
            </div>

            <div>
              <label className="font-medium text-ink block mb-1">Current Bank Balance (₹)</label>
              <Input
                type="number"
                placeholder="50000"
                value={newBalance}
                onChange={(e) => setNewBalance(e.target.value)}
                className="font-mono"
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setAddAccountOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Add Account
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

          <form onSubmit={handleUpdateBalance} className="space-y-4 text-xs pt-2">
            <div>
              <label className="font-medium text-ink block mb-1">Current Balance in Whole Rupees (₹)</label>
              <Input
                type="number"
                value={updatedBalance}
                onChange={(e) => setUpdatedBalance(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditBalanceOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm">
                Save Balance
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
