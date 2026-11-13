"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { IncomeCashflowSection } from "@/components/features/employee-hub/income-cashflow-section";
import { PersonalExpensesSection } from "@/components/features/employee-hub/personal-expenses-section";
import { BankStatementImportSection } from "@/components/features/employee-hub/bank-statement-import-section";
import { SalariedDocumentVaultSection } from "@/components/features/employee-hub/salaried-document-vault-section";
import { ItrFilingAssistant } from "@/components/features/employee-hub/itr-filing-assistant";

// ============================================================================
// Types & Defaults
// ============================================================================

export type HubTab = "income" | "expenses" | "bank-import" | "vault" | "tax" | "receipts";

interface ReimbursementClaim {
  id: string;
  category: "Broadband" | "Mobile" | "Fuel / Cab" | "Books & Courses" | "Client / Team Refreshments" | "Medical / Wellness";
  description: string;
  amountRupees: number;
  date: string;
  status: "Draft" | "Submitted" | "Approved" | "Reimbursed";
  billNumber?: string;
}

const DEFAULT_CLAIMS: ReimbursementClaim[] = [
  {
    id: "clm-1",
    category: "Broadband",
    description: "Airtel Xstream Fiber - Monthly WFH Connection",
    amountRupees: 1179,
    date: "2026-11-01",
    status: "Approved",
    billNumber: "AIR-NOV-9812",
  },
  {
    id: "clm-2",
    category: "Mobile",
    description: "Jio Postpaid Monthly Corporate Allowance",
    amountRupees: 471,
    date: "2026-11-03",
    status: "Approved",
    billNumber: "JIO-POST-443",
  },
  {
    id: "clm-3",
    category: "Fuel / Cab",
    description: "Uber to Client Office for Enterprise Review",
    amountRupees: 640,
    date: "2026-11-07",
    status: "Submitted",
    billNumber: "UBER-7712",
  },
  {
    id: "clm-4",
    category: "Books & Courses",
    description: "Advanced Cloud Architecture Certification Material",
    amountRupees: 2499,
    date: "2026-11-10",
    status: "Submitted",
    billNumber: "ORLY-9011",
  },
];

export default function EmployeeHubPage() {
  const [activeTab, setActiveTab] = React.useState<HubTab>("income");

  // Sync activeTab with URL search parameter (?tab=income, ?tab=expenses, etc.)
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const syncTabFromUrl = () => {
        const params = new URLSearchParams(window.location.search);
        const tabParam = params.get("tab");
        if (
          tabParam &&
          ["income", "expenses", "bank-import", "vault", "tax", "receipts", "claims"].includes(tabParam)
        ) {
          if (tabParam === "claims") {
            setActiveTab("receipts");
            setReceiptsSubTab("claims");
          } else {
            setActiveTab(tabParam as HubTab);
          }
        }
      };

      syncTabFromUrl();
      window.addEventListener("popstate", syncTabFromUrl);
      return () => window.removeEventListener("popstate", syncTabFromUrl);
    }
  }, []);

  const handleTabChange = (tab: HubTab) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", url.toString());
      window.dispatchEvent(new Event("app:tab-change"));
    }
  };

  // --------------------------------------------------------------------------
  // Executive Overview State
  // --------------------------------------------------------------------------
  const [annualGrossSalary, setAnnualGrossSalary] = React.useState<number>(1200000);
  const [monthlyInHandSalary, setMonthlyInHandSalary] = React.useState<number>(78300);
  const [monthlyLivingExpenses, setMonthlyLivingExpenses] = React.useState<number>(45000);
  const [otherIncomeTotal, setOtherIncomeTotal] = React.useState<number>(24000);

  const netMonthlySavings = Math.max(0, monthlyInHandSalary - monthlyLivingExpenses);
  const savingsRate = monthlyInHandSalary > 0 ? Math.round((netMonthlySavings / monthlyInHandSalary) * 100) : 0;

  // Handler when IncomeCashflowSection triggers "Sync to ITR"
  const handleSyncToItr = (data: {
    grossSalary: number;
    exemptHra: number;
    professionalTax: number;
    otherIncome: number;
  }) => {
    setAnnualGrossSalary(data.grossSalary);
    setOtherIncomeTotal(data.otherIncome);
    handleTabChange("tax");
    toast.success("Salary & other incomes synced to ITR-1 Filing Assistant!");
  };

  // --------------------------------------------------------------------------
  // Receipts & Claims Sub-Tab State
  // --------------------------------------------------------------------------
  const [receiptsSubTab, setReceiptsSubTab] = React.useState<"hra" | "claims">("hra");

  // HRA Rent Receipts State
  const [employeeName, setEmployeeName] = React.useState("Abhishek Sharma");
  const [companyName, setCompanyName] = React.useState("Anutech Digital Pvt Ltd");
  const [landlordName, setLandlordName] = React.useState("Rajesh Kumar Verma");
  const [landlordPan, setLandlordPan] = React.useState("ABCDE1234F");
  const [rentAddress, setRentAddress] = React.useState("Flat 402, Green Glen Heights, Sector 48, Gurugram, Haryana - 122018");
  const [monthlyRent, setMonthlyRent] = React.useState(22000);
  const [financialYear, setFinancialYear] = React.useState("2025-2026");

  const months = [
    { name: "April", year: "2025" },
    { name: "May", year: "2025" },
    { name: "June", year: "2025" },
    { name: "July", year: "2025" },
    { name: "August", year: "2025" },
    { name: "September", year: "2025" },
    { name: "October", year: "2025" },
    { name: "November", year: "2025" },
    { name: "December", year: "2025" },
    { name: "January", year: "2026" },
    { name: "February", year: "2026" },
    { name: "March", year: "2026" },
  ];

  // Reimbursement Claims State
  const [claims, setClaims] = React.useState<ReimbursementClaim[]>(DEFAULT_CLAIMS);
  const [isAddClaimOpen, setIsAddClaimOpen] = React.useState(false);
  const [newCategory, setNewCategory] = React.useState<ReimbursementClaim["category"]>("Broadband");
  const [newDesc, setNewDesc] = React.useState("");
  const [newAmount, setNewAmount] = React.useState("");
  const [newBillNo, setNewBillNo] = React.useState("");

  const claimsSummary = React.useMemo(() => {
    const total = claims.reduce((s, c) => s + c.amountRupees, 0);
    const approved = claims.filter((c) => c.status === "Approved" || c.status === "Reimbursed").reduce((s, c) => s + c.amountRupees, 0);
    const pending = claims.filter((c) => c.status === "Submitted" || c.status === "Draft").reduce((s, c) => s + c.amountRupees, 0);
    return { total, approved, pending };
  }, [claims]);

  const handleAddClaim = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDesc.trim() || !newAmount) {
      toast.error("Please enter expense description and amount.");
      return;
    }
    const amt = parseInt(newAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      toast.error("Please enter a valid rupee amount.");
      return;
    }
    const item: ReimbursementClaim = {
      id: "clm-" + Date.now(),
      category: newCategory,
      description: newDesc.trim(),
      amountRupees: amt,
      date: new Date().toISOString().split("T")[0],
      status: "Submitted",
      billNumber: newBillNo.trim() || undefined,
    };
    setClaims([item, ...claims]);
    setIsAddClaimOpen(false);
    setNewDesc("");
    setNewAmount("");
    setNewBillNo("");
    toast.success("Expense reimbursement claim added and queued for HR approval!");
  };

  const copyHrSummary = () => {
    const text = [
      `*Monthly Reimbursement Claims Submission*`,
      `Submitted: ${new Date().toLocaleDateString("en-IN")}`,
      `Total Claim Amount: ₹${claimsSummary.total.toLocaleString("en-IN")}`,
      `------------------------------------------`,
      ...claims.map(
        (c) =>
          `• [${c.category}] ₹${c.amountRupees.toLocaleString("en-IN")} — ${c.description} (Ref: ${c.billNumber || "N/A"}) [Status: ${c.status}]`
      ),
    ].join("\n");

    navigator.clipboard.writeText(text);
    toast.success("HR claim summary copied to clipboard! You can paste it into email or Slack.");
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Top Header & Context Badges */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-hairline">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-3xl font-semibold text-ink">Salaried Pro</h1>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
              Individual Career, Finance &amp; Tax Suite
            </Badge>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              Free Forever Tier
            </Badge>
          </div>
          <p className="text-sm text-ink-3 mt-1.5 max-w-3xl">
            Complete executive suite for salaried professionals: manage your salary income and personal living expenses, organize your digital career vault (Form 16, payslips, AIS), file ITR-1 Sahaj, and generate HRA rent receipts.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/settings/modules">
            <Button variant="outline" size="sm" className="gap-2">
              <Icon name="package" size={14} />
              Modular Plugins
            </Button>
          </Link>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleTabChange("tax")}
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Icon name="rupee" size={14} />
            ITR-1 Filing Assistant
          </Button>
        </div>
      </div>

      {/* Top Executive Summary Cockpit */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          onClick={() => handleTabChange("income")}
          className="p-4 border-2 border-indigo-100 hover:border-indigo-300 transition-all cursor-pointer bg-gradient-to-br from-indigo-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Monthly In-Hand Salary</span>
            <Icon name="wallet" size={16} className="text-indigo-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-indigo-950 mt-1.5 font-mono">
            ₹{monthlyInHandSalary.toLocaleString("en-IN")}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            Net take-home after EPF, PT &amp; TDS
          </span>
        </Card>

        <Card
          onClick={() => handleTabChange("expenses")}
          className="p-4 border-2 border-rose-100 hover:border-rose-300 transition-all cursor-pointer bg-gradient-to-br from-rose-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Monthly Living Spends</span>
            <Icon name="tag" size={16} className="text-rose-600" />
          </div>
          <div className="text-2xl font-serif font-bold text-rose-950 mt-1.5 font-mono">
            ₹{monthlyLivingExpenses.toLocaleString("en-IN")}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            Rent, groceries, EMIs &amp; UPI expenses
          </span>
        </Card>

        <Card
          onClick={() => handleTabChange("income")}
          className="p-4 border-2 border-emerald-100 hover:border-emerald-300 transition-all cursor-pointer bg-gradient-to-br from-emerald-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">Net Monthly Savings</span>
            <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
              {savingsRate}% Saved
            </span>
          </div>
          <div className="text-2xl font-serif font-bold text-emerald-700 mt-1.5 font-mono">
            ₹{netMonthlySavings.toLocaleString("en-IN")}
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            Surplus available for SIP / Emergency Fund
          </span>
        </Card>

        <Card
          onClick={() => handleTabChange("tax")}
          className="p-4 border-2 border-amber-100 hover:border-amber-300 transition-all cursor-pointer bg-gradient-to-br from-amber-50/40 via-paper to-paper"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3 font-medium">ITR-1 Filing (AY 2025–26)</span>
            <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
              Sahaj Ready
            </span>
          </div>
          <div className="text-2xl font-serif font-bold text-amber-900 mt-1.5 font-mono">
            New Regime u/s 115BAC
          </div>
          <span className="text-2xs text-ink-3 mt-1 block">
            Standard deduction ₹75,000 + 87A rebate
          </span>
        </Card>
      </div>

      {/* Synchronized 6-Pillar Tabbed Navigation */}
      <div className="flex items-center gap-2 border-b border-hairline pb-2 overflow-x-auto">
        <button
          onClick={() => handleTabChange("income")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "income"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="wallet" size={16} />
          Income &amp; Cash Flow
        </button>

        <button
          onClick={() => handleTabChange("expenses")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "expenses"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="tag" size={16} />
          Personal Expenses &amp; Budget
        </button>

        <button
          onClick={() => handleTabChange("bank-import")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "bank-import"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="upload_cloud" size={16} />
          Bank Statement Importer
        </button>

        <button
          onClick={() => handleTabChange("vault")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "vault"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="file" size={16} />
          Digital Document Vault
        </button>

        <button
          onClick={() => handleTabChange("tax")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "tax"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="rupee" size={16} />
          ITR-1 Filing &amp; Tax Assistant
        </button>

        <button
          onClick={() => handleTabChange("receipts")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
            activeTab === "receipts"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="receipt" size={16} />
          HRA Receipts &amp; Claims
        </button>
      </div>

      {/* ==================================================================== */}
      {/* PILLAR 1: INCOME & CASH FLOW                                         */}
      {/* ==================================================================== */}
      {activeTab === "income" && (
        <IncomeCashflowSection onSyncToItr={handleSyncToItr} />
      )}

      {/* ==================================================================== */}
      {/* PILLAR 2: PERSONAL EXPENSES & BUDGET TRACKER                         */}
      {/* ==================================================================== */}
      {activeTab === "expenses" && (
        <PersonalExpensesSection
          monthlySalaryRupees={monthlyInHandSalary}
          onNavigateToBankImport={() => handleTabChange("bank-import")}
        />
      )}

      {/* ==================================================================== */}
      {/* PILLAR 3: PERSONAL BANK STATEMENT IMPORTER (CSV/EXCEL)               */}
      {/* ==================================================================== */}
      {activeTab === "bank-import" && (
        <BankStatementImportSection
          onNavigateToExpenses={() => handleTabChange("expenses")}
        />
      )}

      {/* ==================================================================== */}
      {/* PILLAR 4: DIGITAL DOCUMENT VAULT (DIGIVAULT)                         */}
      {/* ==================================================================== */}
      {activeTab === "vault" && (
        <SalariedDocumentVaultSection onNavigateToItr={() => handleTabChange("tax")} />
      )}

      {/* ==================================================================== */}
      {/* PILLAR 5: ITR-1 (SAHAJ) FILING ASSISTANT                             */}
      {/* ==================================================================== */}
      {activeTab === "tax" && (
        <ItrFilingAssistant
          initialSalaryGross={annualGrossSalary}
          initialOtherIncome={otherIncomeTotal}
        />
      )}

      {/* ==================================================================== */}
      {/* PILLAR 6: HRA RENT RECEIPTS & COMPANY REIMBURSEMENTS                 */}
      {/* ==================================================================== */}
      {activeTab === "receipts" && (
        <div className="space-y-6">
          {/* Sub-navigation between HRA Receipts and HR Claims */}
          <div className="flex items-center justify-between border-b border-hairline pb-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setReceiptsSubTab("hra")}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  receiptsSubTab === "hra"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-paper-2 text-ink-2 hover:text-ink"
                }`}
              >
                12-Month HRA Rent Receipts (Sec 10(13A))
              </button>
              <button
                onClick={() => setReceiptsSubTab("claims")}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  receiptsSubTab === "claims"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-paper-2 text-ink-2 hover:text-ink"
                }`}
              >
                Company Reimbursements ({claims.length})
              </button>
            </div>

            {receiptsSubTab === "hra" ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => window.print()}
                className="gap-2"
              >
                <Icon name="printer" size={14} />
                Print / Save PDF (12 Months)
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={copyHrSummary}
                className="gap-1.5"
              >
                <Icon name="copy" size={14} />
                Copy for HR / Slack
              </Button>
            )}
          </div>

          {receiptsSubTab === "hra" ? (
            <div className="space-y-6">
              {/* Controls Bar */}
              <Card className="p-5 space-y-4">
                <div className="border-b border-hairline pb-2 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-sm text-ink">Rent Receipt Configuration</h3>
                    <p className="text-xs text-ink-3">
                      Generate official Section 10(13A) compliant rent receipts with Landlord PAN for tax exemption.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Employee Name</label>
                    <input
                      type="text"
                      value={employeeName}
                      onChange={(e) => setEmployeeName(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Company / Employer</label>
                    <input
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Monthly Rent (₹)</label>
                    <input
                      type="number"
                      value={monthlyRent}
                      onChange={(e) => setMonthlyRent(Number(e.target.value) || 0)}
                      className="w-full px-3 py-1.5 font-mono border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Landlord Name</label>
                    <input
                      type="text"
                      value={landlordName}
                      onChange={(e) => setLandlordName(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Landlord PAN (Mandatory &gt; ₹1L/yr)</label>
                    <input
                      type="text"
                      value={landlordPan}
                      onChange={(e) => setLandlordPan(e.target.value.toUpperCase())}
                      className="w-full px-3 py-1.5 font-mono uppercase border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="font-medium text-ink-2 block mb-1">Financial Year</label>
                    <input
                      type="text"
                      value={financialYear}
                      onChange={(e) => setFinancialYear(e.target.value)}
                      className="w-full px-3 py-1.5 font-mono border rounded border-hairline bg-paper"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <label className="font-medium text-ink-2 block mb-1">Rented House Address</label>
                    <input
                      type="text"
                      value={rentAddress}
                      onChange={(e) => setRentAddress(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded border-hairline bg-paper"
                    />
                  </div>
                </div>
              </Card>

              {/* 12-Month Printable Receipts Grid */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-ink">12 Months Generated Receipts Preview</h4>
                  <span className="text-2xs text-ink-3">Official Indian Income Tax Form Format</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {months.map((m, idx) => (
                    <Card key={idx} className="p-4 border-2 border-hairline space-y-3 bg-white relative">
                      <div className="flex items-center justify-between border-b border-hairline pb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-ink">
                          Rent Receipt — {m.name} {m.year}
                        </span>
                        <span className="text-2xs font-mono bg-zinc-100 text-zinc-700 px-1.5 py-0.5 rounded">
                          Receipt #{idx + 1}
                        </span>
                      </div>

                      <p className="text-2xs text-ink-2 leading-relaxed">
                        Received sum of <b>₹{monthlyRent.toLocaleString("en-IN")}</b> from <b>{employeeName}</b> (Employer: {companyName}) towards rent for the month of <b>{m.name} {m.year}</b> for residential property at:
                      </p>

                      <p className="text-2xs text-ink-3 italic bg-paper-2/40 p-2 rounded">
                        {rentAddress}
                      </p>

                      <div className="pt-2 border-t border-hairline text-2xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-ink-3">Landlord:</span>
                          <span className="font-medium text-ink">{landlordName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-3">Landlord PAN:</span>
                          <span className="font-mono text-ink font-semibold">{landlordPan}</span>
                        </div>
                      </div>

                      <div className="pt-4 flex justify-between items-end text-2xs text-ink-3">
                        <span className="border-t border-dashed border-hairline pt-1">Revenue Stamp</span>
                        <span className="border-t border-ink-3 pt-1 font-medium text-ink">Landlord Signature</span>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="p-4">
                  <span className="text-xs text-ink-3">Total Expenses Claimed</span>
                  <div className="text-2xl font-serif font-bold text-ink mt-1">
                    ₹{claimsSummary.total.toLocaleString("en-IN")}
                  </div>
                  <span className="text-2xs text-ink-3 mt-1 block">Current billing month</span>
                </Card>

                <Card className="p-4">
                  <span className="text-xs text-emerald-700 font-medium">Approved / Reimbursed</span>
                  <div className="text-2xl font-serif font-bold text-emerald-600 mt-1">
                    ₹{claimsSummary.approved.toLocaleString("en-IN")}
                  </div>
                  <span className="text-2xs text-ink-3 mt-1 block">Ready for payroll credit</span>
                </Card>

                <Card className="p-4">
                  <span className="text-xs text-amber-700 font-medium">Pending HR Review</span>
                  <div className="text-2xl font-serif font-bold text-amber-600 mt-1">
                    ₹{claimsSummary.pending.toLocaleString("en-IN")}
                  </div>
                  <span className="text-2xs text-ink-3 mt-1 block">Awaiting finance approval</span>
                </Card>
              </div>

              {/* Action Bar */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">Corporate Expense Claims</h3>
                  <p className="text-xs text-ink-3">Track work-from-home, internet, and client travel expenses</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsAddClaimOpen(!isAddClaimOpen)}
                    className="gap-1.5"
                  >
                    <Icon name="plus" size={14} />
                    + New Expense Claim
                  </Button>
                </div>
              </div>

              {/* Add Claim Form */}
              {isAddClaimOpen && (
                <Card className="p-5 border-2 border-indigo-200 bg-indigo-50/20 space-y-4">
                  <div className="flex items-center justify-between pb-2 border-b border-indigo-100">
                    <h4 className="font-semibold text-sm text-ink">Add New Expense Claim</h4>
                    <button
                      onClick={() => setIsAddClaimOpen(false)}
                      className="text-ink-3 hover:text-ink text-sm"
                    >
                      ✕
                    </button>
                  </div>

                  <form onSubmit={handleAddClaim} className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="text-xs font-medium text-ink-2 block mb-1">Expense Category</label>
                      <select
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value as ReimbursementClaim["category"])}
                        className="w-full text-xs px-3 py-2 border rounded-md border-hairline bg-paper"
                      >
                        <option value="Broadband">Broadband / Internet</option>
                        <option value="Mobile">Mobile / Postpaid Bill</option>
                        <option value="Fuel / Cab">Fuel / Cab / Client Travel</option>
                        <option value="Books & Courses">Books &amp; Certifications</option>
                        <option value="Client / Team Refreshments">Client / Team Refreshments</option>
                        <option value="Medical / Wellness">Medical / Wellness</option>
                      </select>
                    </div>

                    <div className="md:col-span-2">
                      <label className="text-xs font-medium text-ink-2 block mb-1">Description / Purpose</label>
                      <input
                        type="text"
                        placeholder="e.g. Fiber Internet Bill for November WFH"
                        value={newDesc}
                        onChange={(e) => setNewDesc(e.target.value)}
                        className="w-full text-xs px-3 py-2 border rounded-md border-hairline bg-paper"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium text-ink-2 block mb-1">Amount (₹)</label>
                      <input
                        type="number"
                        placeholder="1179"
                        value={newAmount}
                        onChange={(e) => setNewAmount(e.target.value)}
                        className="w-full text-xs font-mono px-3 py-2 border rounded-md border-hairline bg-paper"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium text-ink-2 block mb-1">Invoice / Receipt No. (Optional)</label>
                      <input
                        type="text"
                        placeholder="e.g. INV-9812"
                        value={newBillNo}
                        onChange={(e) => setNewBillNo(e.target.value)}
                        className="w-full text-xs px-3 py-2 border rounded-md border-hairline bg-paper"
                      />
                    </div>

                    <div className="md:col-span-3 flex items-center gap-2 justify-end pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsAddClaimOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" variant="primary" size="sm">
                        Submit Claim
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              {/* Claims Table */}
              <Card className="overflow-hidden border border-hairline">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-paper-2/60 border-b border-hairline text-ink-3 font-semibold uppercase tracking-wider text-2xs">
                      <tr>
                        <th className="p-3">Date</th>
                        <th className="p-3">Category</th>
                        <th className="p-3">Description &amp; Receipt</th>
                        <th className="p-3 text-right">Amount (₹)</th>
                        <th className="p-3 text-center">Status</th>
                        <th className="p-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {claims.map((claim) => (
                        <tr key={claim.id} className="hover:bg-paper-2/30 transition-colors">
                          <td className="p-3 font-mono text-ink-2">{claim.date}</td>
                          <td className="p-3 font-medium text-ink">{claim.category}</td>
                          <td className="p-3">
                            <div className="text-ink">{claim.description}</div>
                            {claim.billNumber && (
                              <span className="text-2xs font-mono text-ink-3">Ref: {claim.billNumber}</span>
                            )}
                          </td>
                          <td className="p-3 text-right font-mono font-semibold text-ink">
                            ₹{claim.amountRupees.toLocaleString("en-IN")}
                          </td>
                          <td className="p-3 text-center">
                            <span
                              className={`text-2xs px-2 py-0.5 rounded-full font-medium ${
                                claim.status === "Approved" || claim.status === "Reimbursed"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : claim.status === "Submitted"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-zinc-100 text-zinc-700"
                              }`}
                            >
                              {claim.status}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            <button
                              onClick={() => {
                                setClaims(claims.filter((c) => c.id !== claim.id));
                                toast.success("Claim removed.");
                              }}
                              className="text-ink-3 hover:text-rose-600 transition-colors"
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
