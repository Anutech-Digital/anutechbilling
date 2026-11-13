"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { toast } from "sonner";
import {
  PERSONAL_EXPENSE_CATEGORIES,
  type PersonalExpense,
  type PersonalExpenseCategory,
} from "./personal-expenses-section";

export interface ParsedBankTxn {
  id: string;
  date: string;
  narration: string;
  debit: number; // ₹ Whole Rupees (Rule 4)
  credit: number; // ₹ Whole Rupees (Rule 4)
  balance: number | null;
  detectedCategory: PersonalExpenseCategory | "Salary Income";
  isSalary: boolean;
  reference?: string;
}

const STORAGE_EXPENSES_KEY = "salaried_pro_personal_expenses_v1";
const STORAGE_BANK_TXNS_KEY = "salaried_pro_imported_bank_txns_v1";

const SAMPLE_CSV = `Date,Narration,Chq/Ref No,Withdrawal (Dr),Deposit (Cr),Closing Balance
01/11/2026,NEFT CR-INFOSYS TECHNOLOGIES-SALARY-NOV26,CMS10982341,,118500,142500
01/11/2026,UPI-RENT PAYMENT TO SURESH KUMAR-PAYTM,UPI99218273,22000,,120500
02/11/2026,ACH DEBIT-HDFC LIFE INSURANCE ANNUAL PREM,ACH881239,12500,,108000
03/11/2026,POS-DMART SUPERMARKET WHITEFIELD BLR,POS448102,6450,,101550
04/11/2026,UPI-SWIGGY FOOD ORDER BANGALORE,UPI88129011,840,,100710
05/11/2026,BILLDESK-AIRTEL XSTREAM FIBER BROADBAND,BIL771239,1179,,99531
06/11/2026,POS-HPCL PETROL BUNK AIRPORT ROAD,POS901238,3500,,96031
07/11/2026,UPI-BLINKIT GROCERY INSTANT 10MIN,UPI661209,560,,95471
08/11/2026,E-COMM-AMAZON PAY INDIA APPAREL & BOOKS,ECOM11029,2499,,92972
10/11/2026,UPI-UBER RIDE CLIENT MEETING KORAMANGALA,UPI441920,640,,92332`;

// Auto-categorisation heuristics for Indian bank statements
function categorizeNarration(narration: string, debit: number, credit: number): {
  cat: PersonalExpenseCategory | "Salary Income";
  isSalary: boolean;
} {
  const norm = narration.toUpperCase();

  // Salary detection
  if (credit > 0 && (norm.includes("SALARY") || norm.includes("PAYROLL") || norm.includes("CMS") || credit >= 30000)) {
    return { cat: "Salary Income", isSalary: true };
  }

  if (debit > 0) {
    if (norm.includes("RENT") || norm.includes("LANDLORD") || norm.includes("MAINTENANCE")) {
      return { cat: "Housing & Rent", isSalary: false };
    }
    if (norm.includes("SWIGGY") || norm.includes("ZOMATO") || norm.includes("DMART") || norm.includes("BLINKIT") || norm.includes("ZEPTO") || norm.includes("BIGBASKET") || norm.includes("INSTAMART")) {
      return { cat: "Food & Groceries", isSalary: false };
    }
    if (norm.includes("PETROL") || norm.includes("HPCL") || norm.includes("BPCL") || norm.includes("IOCL") || norm.includes("UBER") || norm.includes("OLA") || norm.includes("FASTAG") || norm.includes("METRO")) {
      return { cat: "Fuel & Commute", isSalary: false };
    }
    if (norm.includes("AIRTEL") || norm.includes("JIO") || norm.includes("BILLDESK") || norm.includes("DISCOM") || norm.includes("ELECTRIC") || norm.includes("BESCOM") || norm.includes("TATA POWER")) {
      return { cat: "Utilities & Bills", isSalary: false };
    }
    if (norm.includes("AMAZON") || norm.includes("FLIPKART") || norm.includes("MYNTRA") || norm.includes("ECOM")) {
      return { cat: "Shopping & Lifestyle", isLifestyle: true, isSalary: false };
    }
    if (norm.includes("NETFLIX") || norm.includes("SPOTIFY") || norm.includes("PRIME") || norm.includes("HOTSTAR") || norm.includes("YOUTUBE")) {
      return { cat: "Subscriptions & OTT", isSalary: false };
    }
    if (norm.includes("APOLLO") || norm.includes("1MG") || norm.includes("PHARMACY") || norm.includes("HOSPITAL") || norm.includes("PRACTO")) {
      return { cat: "Health & Medical", isSalary: false };
    }
    if (norm.includes("EMI") || norm.includes("LOAN") || norm.includes("INSURANCE") || norm.includes("HDFC LIFE") || norm.includes("LIC")) {
      return { cat: "EMI & Loans", isSalary: false };
    }
    if (norm.includes("CAFE") || norm.includes("RESTAURANT") || norm.includes("PVR") || norm.includes("INOX") || norm.includes("BAR")) {
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

function parseIndianDate(raw: string): string {
  const s = raw.trim().replace(/"/g, "");
  if (!s) return istToday();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  }
  return istToday();
}

function parseRupeeAmount(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[₹,\s"'\r\n]/g, "").replace(/[Cc][Rr]$/, "").replace(/[Dd][Rr]$/, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n);
}

interface Props {
  onNavigateToExpenses?: () => void;
}

export function BankStatementImportSection({ onNavigateToExpenses }: Props) {
  const [pastedText, setPastedText] = React.useState<string>("");
  const [selectedBank, setSelectedBank] = React.useState<string>("hdfc");
  const [filterType, setFilterType] = React.useState<"all" | "debits" | "credits">("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  const [transactions, setTransactions] = React.useState<ParsedBankTxn[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(STORAGE_BANK_TXNS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // fallback
    }
    return [];
  });

  // Save transactions to localStorage
  const saveTransactions = React.useCallback((items: ParsedBankTxn[]) => {
    setTransactions(items);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_BANK_TXNS_KEY, JSON.stringify(items));
      } catch {
        // ignore
      }
    }
  }, []);

  // Parse raw text or file
  const handleParseStatement = (textToParse: string) => {
    if (!textToParse.trim()) {
      toast.error("Please paste CSV data or upload a bank statement file.");
      return;
    }

    const lines = textToParse
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) {
      toast.error("Invalid statement format. At least header and 1 data row required.");
      return;
    }

    // Identify header
    let headerIdx = -1;
    for (let i = 0; i < Math.min(25, lines.length); i++) {
      const lower = lines[i].toLowerCase();
      if (
        (lower.includes("date") || lower.includes("txn")) &&
        (lower.includes("narration") || lower.includes("description") || lower.includes("particulars")) &&
        (lower.includes("dr") || lower.includes("cr") || lower.includes("withdrawal") || lower.includes("deposit") || lower.includes("debit") || lower.includes("credit"))
      ) {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx === -1) {
      // fallback to line 0 if it contains commas
      headerIdx = 0;
    }

    const headers = parseCSVLine(lines[headerIdx]).map((h) => h.toLowerCase());
    const dateIdx = headers.findIndex((h) => h.includes("date") || h.includes("txn"));
    const narrIdx = headers.findIndex(
      (h) => h.includes("narration") || h.includes("description") || h.includes("particulars") || h.includes("detail")
    );
    const debitIdx = headers.findIndex(
      (h) => h.includes("withdrawal") || h.includes("debit") || h.includes("dr")
    );
    const creditIdx = headers.findIndex(
      (h) => h.includes("deposit") || h.includes("credit") || h.includes("cr")
    );
    const balIdx = headers.findIndex((h) => h.includes("balance") || h.includes("closing"));
    const refIdx = headers.findIndex(
      (h) => h.includes("ref") || h.includes("chq") || h.includes("cheque") || h.includes("utr")
    );

    const parsed: ParsedBankTxn[] = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 3) continue;

      const dateStr = parseIndianDate(cols[dateIdx >= 0 ? dateIdx : 0] || "");
      const narration = (cols[narrIdx >= 0 ? narrIdx : 1] || "Bank Transaction").replace(/"/g, "").trim();
      const debitVal = parseRupeeAmount(cols[debitIdx >= 0 ? debitIdx : 3] || "");
      const creditVal = parseRupeeAmount(cols[creditIdx >= 0 ? creditIdx : 4] || "");
      const balVal = balIdx >= 0 ? parseRupeeAmount(cols[balIdx]) : null;
      const refVal = refIdx >= 0 ? cols[refIdx]?.replace(/"/g, "").trim() : undefined;

      if (debitVal === 0 && creditVal === 0) continue;

      const { cat, isSalary } = categorizeNarration(narration, debitVal, creditVal);

      parsed.push({
        id: `btxn-${Date.now()}-${i}`,
        date: dateStr,
        narration,
        debit: debitVal,
        credit: creditVal,
        balance: balVal,
        detectedCategory: cat,
        isSalary,
        reference: refVal,
      });
    }

    if (parsed.length === 0) {
      toast.error("No valid transactions found in statement. Please verify column layout.");
      return;
    }

    saveTransactions(parsed);
    toast.success(`Imported ${parsed.length} transactions from bank statement.`);
    setPastedText("");
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        handleParseStatement(content);
      }
    };
    reader.readAsText(file);
  };

  const handleLoadSample = () => {
    handleParseStatement(SAMPLE_CSV);
    toast.success("Loaded demo Indian bank statement (Salary + UPI + Bills).");
  };

  const handleClear = () => {
    saveTransactions([]);
    toast.success("Cleared imported statement data.");
  };

  // Sync single debit to Personal Expenses
  const handleSyncToExpense = (txn: ParsedBankTxn) => {
    if (txn.debit <= 0) return;

    const category: PersonalExpenseCategory =
      txn.detectedCategory === "Salary Income" ? "Miscellaneous" : txn.detectedCategory;

    let existingExpenses: PersonalExpense[] = [];
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_EXPENSES_KEY);
        if (stored) existingExpenses = JSON.parse(stored);
      } catch {
        // ignore
      }
    }

    const newExpense: PersonalExpense = {
      id: `pe-synced-${Date.now()}`,
      date: txn.date,
      category,
      description: txn.narration,
      amountRupees: txn.debit,
      paymentMode: txn.narration.toUpperCase().includes("UPI")
        ? "UPI"
        : txn.narration.toUpperCase().includes("POS")
        ? "Debit Card"
        : "Net Banking",
    };

    const updated = [newExpense, ...existingExpenses];
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_EXPENSES_KEY, JSON.stringify(updated));
    }

    toast.success(`Synced ₹${txn.debit.toLocaleString("en-IN")} to Personal Expenses (${category})`);
  };

  // Bulk sync all debits to Personal Expenses
  const handleBulkSyncAllDebits = () => {
    const debits = transactions.filter((t) => t.debit > 0);
    if (debits.length === 0) {
      toast.error("No debit expenses found to sync.");
      return;
    }

    let existingExpenses: PersonalExpense[] = [];
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_EXPENSES_KEY);
        if (stored) existingExpenses = JSON.parse(stored);
      } catch {
        // ignore
      }
    }

    const newEntries: PersonalExpense[] = debits.map((t, idx) => ({
      id: `pe-bulk-${Date.now()}-${idx}`,
      date: t.date,
      category: t.detectedCategory === "Salary Income" ? "Miscellaneous" : t.detectedCategory,
      description: t.narration,
      amountRupees: t.debit,
      paymentMode: t.narration.toUpperCase().includes("UPI")
        ? "UPI"
        : t.narration.toUpperCase().includes("POS")
        ? "Debit Card"
        : "Net Banking",
    }));

    const merged = [...newEntries, ...existingExpenses];
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_EXPENSES_KEY, JSON.stringify(merged));
    }

    toast.success(`Synced all ${debits.length} debit transactions to Personal Expenses!`);
  };

  // Financial summary
  const totalCredits = React.useMemo(() => {
    return transactions.reduce((sum, t) => sum + t.credit, 0);
  }, [transactions]);

  const totalDebits = React.useMemo(() => {
    return transactions.reduce((sum, t) => sum + t.debit, 0);
  }, [transactions]);

  const netSavings = totalCredits - totalDebits;

  // Filtered transactions
  const filteredTxns = React.useMemo(() => {
    return transactions.filter((t) => {
      const matchType =
        filterType === "all" ||
        (filterType === "debits" && t.debit > 0) ||
        (filterType === "credits" && t.credit > 0);
      const matchSearch =
        !searchQuery.trim() ||
        t.narration.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.detectedCategory.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (t.reference && t.reference.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchType && matchSearch;
    });
  }, [transactions, filterType, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-surface-2/60 p-4 md:p-5 rounded-xl border border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge className="bg-indigo-500/10 text-indigo-600 border-indigo-500/20">
              Savings Account Parser
            </Badge>
            <span className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
              Personal Banking
            </span>
          </div>
          <h2 className="font-serif text-xl md:text-2xl tracking-tight">
            Personal Bank Statement Importer
          </h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl">
            Upload your personal Savings Bank statement (HDFC, SBI, ICICI, Axis, Kotak CSV) to
            automatically categorize salary inflow, track UPI &amp; card spends, and sync to personal
            expenses.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" icon="sparkles" onClick={handleLoadSample} className="text-xs">
            ⚡ Load Demo Statement
          </Button>
          {transactions.length > 0 && (
            <Button
              variant="outline"
              icon="trash"
              onClick={handleClear}
              className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Upload & Parse Box */}
      {transactions.length === 0 ? (
        <Card className="p-6 md:p-8 bg-surface border-border border-dashed border-2 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
            <Icon name="upload-cloud" className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-serif text-lg font-semibold text-ink">
              Upload your Bank Statement CSV
            </h3>
            <p className="text-xs text-ink-3 mt-1 max-w-md mx-auto">
              Export your statement from your Net Banking app (HDFC, ICICI, SBI, Axis, Kotak) as CSV or
              Excel, and drag it here.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <label className="cursor-pointer">
              <span className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-xs font-medium transition-colors shadow-sm">
                <Icon name="file-text" className="w-4 h-4" />
                Select CSV File from Computer
              </span>
              <input
                type="file"
                accept=".csv, text/csv"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>

            <span className="text-2xs text-ink-4 uppercase font-semibold">OR</span>

            <Button
              variant="outline"
              icon="sparkles"
              onClick={handleLoadSample}
              className="text-xs font-medium"
            >
              Test with Demo Statement (1-Click)
            </Button>
          </div>

          {/* Collapsible raw text paste */}
          <details className="mt-4 text-left max-w-xl mx-auto pt-2">
            <summary className="text-2xs text-ink-3 cursor-pointer hover:text-ink font-medium">
              + Or paste raw CSV text directly
            </summary>
            <div className="space-y-2 mt-2">
              <textarea
                rows={4}
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste CSV rows here: Date, Narration, Ref, Debit, Credit, Balance..."
                className="w-full text-xs font-mono p-2.5 rounded-lg border border-border bg-surface-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <Button
                variant="default"
                size="sm"
                onClick={() => handleParseStatement(pastedText)}
                className="text-xs bg-indigo-600 text-white hover:bg-indigo-700"
              >
                Parse Pasted CSV
              </Button>
            </div>
          </details>
        </Card>
      ) : (
        <>
          {/* Financial Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4 bg-surface border-border">
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">
                Total Salary &amp; Inflow (Credits)
              </p>
              <p className="font-serif text-2xl font-bold text-emerald-600 mt-1">
                +{rupee(totalCredits)}
              </p>
              <p className="text-2xs text-ink-3 mt-1">
                {transactions.filter((t) => t.credit > 0).length} deposit entries
              </p>
            </Card>

            <Card className="p-4 bg-surface border-border">
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">
                Total Expenses &amp; Spends (Debits)
              </p>
              <p className="font-serif text-2xl font-bold text-red-600 mt-1">
                -{rupee(totalDebits)}
              </p>
              <p className="text-2xs text-ink-3 mt-1">
                {transactions.filter((t) => t.debit > 0).length} withdrawal/UPI entries
              </p>
            </Card>

            <Card className="p-4 bg-surface border-border">
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-medium">
                Net Period Savings
              </p>
              <p
                className={`font-serif text-2xl font-bold mt-1 ${
                  netSavings >= 0 ? "text-indigo-600" : "text-amber-600"
                }`}
              >
                {netSavings >= 0 ? "+" : ""}
                {rupee(netSavings)}
              </p>
              <p className="text-2xs text-ink-3 mt-1">Inflow minus all debits</p>
            </Card>
          </div>

          {/* Actions & Filters */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
              <button
                type="button"
                onClick={() => setFilterType("all")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filterType === "all"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                }`}
              >
                All ({transactions.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("debits")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filterType === "debits"
                    ? "bg-red-600 text-white shadow-sm"
                    : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                }`}
              >
                Debits / Spends ({transactions.filter((t) => t.debit > 0).length})
              </button>
              <button
                type="button"
                onClick={() => setFilterType("credits")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filterType === "credits"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                }`}
              >
                Salary &amp; Credits ({transactions.filter((t) => t.credit > 0).length})
              </button>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
              <div className="relative w-full sm:w-60">
                <Input
                  placeholder="Search narration or UTR..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="text-xs pl-8 h-8"
                />
                <span className="absolute left-2.5 top-2 text-ink-3">
                  <Icon name="search" className="w-3.5 h-3.5" />
                </span>
              </div>

              <Button
                variant="default"
                icon="refresh"
                onClick={handleBulkSyncAllDebits}
                className="text-xs h-8 bg-indigo-600 hover:bg-indigo-700 text-white"
                title="Copy all debit rows into Personal Expense Tracker"
              >
                ⚡ Sync Debits to Expenses
              </Button>

              {onNavigateToExpenses && (
                <Button
                  variant="outline"
                  icon="arrow-up-right"
                  onClick={onNavigateToExpenses}
                  className="text-xs h-8"
                >
                  View Expenses
                </Button>
              )}
            </div>
          </div>

          {/* Transactions Table */}
          <Card className="p-0 overflow-hidden border-border bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-2/70 text-ink-3 border-b border-border uppercase text-2xs font-semibold">
                  <tr>
                    <th className="p-3 w-28">Date</th>
                    <th className="p-3">Narration &amp; Reference</th>
                    <th className="p-3 w-36">Category</th>
                    <th className="p-3 w-28 text-right">Debit (Dr)</th>
                    <th className="p-3 w-28 text-right">Credit (Cr)</th>
                    <th className="p-3 w-28 text-right">Balance</th>
                    <th className="p-3 w-24 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredTxns.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-ink-3">
                        No transactions match the selected filter.
                      </td>
                    </tr>
                  ) : (
                    filteredTxns.map((t) => (
                      <tr key={t.id} className="hover:bg-surface-2/40 transition-colors">
                        <td className="p-3 whitespace-nowrap text-ink-2 font-mono">
                          {formatDate(t.date, "short")}
                        </td>
                        <td className="p-3">
                          <p className="font-medium text-ink line-clamp-1">{t.narration}</p>
                          {t.reference && (
                            <p className="text-2xs text-ink-3 font-mono mt-0.5">Ref: {t.reference}</p>
                          )}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          {t.isSalary ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-2xs font-semibold">
                              💰 Monthly Salary
                            </Badge>
                          ) : (
                            <Badge className="bg-surface-2 text-ink-2 text-2xs font-normal">
                              {t.detectedCategory}
                            </Badge>
                          )}
                        </td>
                        <td className="p-3 text-right font-serif font-semibold text-red-600 whitespace-nowrap">
                          {t.debit > 0 ? `-${rupee(t.debit)}` : "—"}
                        </td>
                        <td className="p-3 text-right font-serif font-semibold text-emerald-600 whitespace-nowrap">
                          {t.credit > 0 ? `+${rupee(t.credit)}` : "—"}
                        </td>
                        <td className="p-3 text-right font-serif text-ink-3 whitespace-nowrap">
                          {t.balance != null ? rupee(t.balance) : "—"}
                        </td>
                        <td className="p-3 text-center whitespace-nowrap">
                          {t.debit > 0 ? (
                            <button
                              type="button"
                              onClick={() => handleSyncToExpense(t)}
                              className="text-2xs text-indigo-600 hover:text-indigo-800 font-medium hover:underline p-1"
                              title="Sync to Personal Expenses"
                            >
                              + To Expense
                            </button>
                          ) : (
                            <span className="text-2xs text-ink-4">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
