"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";

// ============================================================================
// Types & Defaults
// ============================================================================

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

const VAULT_CHECKLIST = [
  { id: "f16", label: "Form 16 (Part A & B from Employer)", category: "Tax Compliance", mandatory: true },
  { id: "slips", label: "Last 3 Months Salary Payslips (PDF)", category: "Proof of Income", mandatory: true },
  { id: "offer", label: "Appointment & Current Appraisal/Increment Letter", category: "Employment", mandatory: false },
  { id: "uan", label: "EPFO UAN Card & Member Passbook Statement", category: "Retirement & PF", mandatory: true },
  { id: "rent", label: "12-Month HRA Rent Receipts with Landlord PAN", category: "HRA Exemption", mandatory: true },
  { id: "inv", label: "Section 80C Investment Proofs (ELSS, PPF, Life Insurance)", category: "Tax Exemption", mandatory: false },
  { id: "med", label: "Section 80D Health Insurance Premium Statement", category: "Tax Exemption", mandatory: false },
  { id: "ais", label: "Form 26AS & AIS / TIS Download from Income Tax Portal", category: "Annual ITR Filing", mandatory: true },
];

export default function EmployeeHubPage() {
  const [activeTab, setActiveTab] = React.useState<"tax" | "claims" | "receipts" | "vault">("tax");

  // --------------------------------------------------------------------------
  // Tab 1: Tax Regime State & Calculations
  // --------------------------------------------------------------------------
  const [annualCtc, setAnnualCtc] = React.useState<number>(1200000); // 12 LPA
  const [basicSalary, setBasicSalary] = React.useState<number>(600000); // 50%
  const [annualRentPaid, setAnnualRentPaid] = React.useState<number>(240000); // ₹20k/mo
  const [isMetroCity, setIsMetroCity] = React.useState<boolean>(true);
  const [deduction80C, setDeduction80C] = React.useState<number>(150000); // Max 1.5L
  const [deduction80D, setDeduction80D] = React.useState<number>(25000); // Health insurance
  const [homeLoanInterest, setHomeLoanInterest] = React.useState<number>(0); // Sec 24b
  const [npsContribution, setNpsContribution] = React.useState<number>(50000); // Sec 80CCD(1B)

  // Tax calculations FY 2025–26
  const taxCalculations = React.useMemo(() => {
    // --- New Regime (FY 2025-26 Budget Slabs) ---
    // Standard deduction: ₹75,000
    const newStdDeduction = 75000;
    const newTaxableIncome = Math.max(0, annualCtc - newStdDeduction);

    let newTaxBeforeRebate = 0;
    if (newTaxableIncome <= 300000) {
      newTaxBeforeRebate = 0;
    } else if (newTaxableIncome <= 700000) {
      newTaxBeforeRebate = (newTaxableIncome - 300000) * 0.05;
    } else if (newTaxableIncome <= 1000000) {
      newTaxBeforeRebate = 20000 + (newTaxableIncome - 700000) * 0.1;
    } else if (newTaxableIncome <= 1200000) {
      newTaxBeforeRebate = 20000 + 30000 + (newTaxableIncome - 1000000) * 0.15;
    } else if (newTaxableIncome <= 1500000) {
      newTaxBeforeRebate = 20000 + 30000 + 30000 + (newTaxableIncome - 1200000) * 0.2;
    } else {
      newTaxBeforeRebate = 20000 + 30000 + 30000 + 60000 + (newTaxableIncome - 1500000) * 0.3;
    }

    // Section 87A rebate for New Regime up to ₹7,00,000 income
    const newTaxPayable = newTaxableIncome <= 700000 ? 0 : Math.round(newTaxBeforeRebate * 1.04);
    const newAnnualInHand = annualCtc - newTaxPayable;
    const newMonthlyInHand = Math.round(newAnnualInHand / 12);

    // --- Old Regime ---
    // Standard deduction: ₹50,000
    const oldStdDeduction = 50000;

    // HRA Exemption Calculation
    // Min of:
    // 1. Actual HRA received (assume 40% of basic)
    // 2. Rent paid - 10% of basic
    // 3. 50% of basic (metro) or 40% (non-metro)
    const assumedHraReceived = Math.round(basicSalary * 0.4);
    const rentMinusTenPercent = Math.max(0, annualRentPaid - basicSalary * 0.1);
    const metroCap = isMetroCity ? basicSalary * 0.5 : basicSalary * 0.4;
    const hraExemption = Math.min(assumedHraReceived, rentMinusTenPercent, metroCap);

    const totalOldDeductions =
      oldStdDeduction +
      hraExemption +
      Math.min(150000, deduction80C) +
      Math.min(75000, deduction80D) +
      Math.min(200000, homeLoanInterest) +
      Math.min(50000, npsContribution);

    const oldTaxableIncome = Math.max(0, annualCtc - totalOldDeductions);

    let oldTaxBeforeRebate = 0;
    if (oldTaxableIncome <= 250000) {
      oldTaxBeforeRebate = 0;
    } else if (oldTaxableIncome <= 500000) {
      oldTaxBeforeRebate = (oldTaxableIncome - 250000) * 0.05;
    } else if (oldTaxableIncome <= 1000000) {
      oldTaxBeforeRebate = 12500 + (oldTaxableIncome - 500000) * 0.2;
    } else {
      oldTaxBeforeRebate = 12500 + 100000 + (oldTaxableIncome - 1000000) * 0.3;
    }

    // Section 87A rebate for Old Regime up to ₹5,00,000 income
    const oldTaxPayable = oldTaxableIncome <= 500000 ? 0 : Math.round(oldTaxBeforeRebate * 1.04);
    const oldAnnualInHand = annualCtc - oldTaxPayable;
    const oldMonthlyInHand = Math.round(oldAnnualInHand / 12);

    const taxDifference = oldTaxPayable - newTaxPayable;
    const recommended = taxDifference >= 0 ? "NEW" : "OLD";

    return {
      newTaxableIncome,
      newTaxPayable,
      newAnnualInHand,
      newMonthlyInHand,
      newStdDeduction,
      oldTaxableIncome,
      oldTaxPayable,
      oldAnnualInHand,
      oldMonthlyInHand,
      oldStdDeduction,
      hraExemption,
      totalOldDeductions,
      taxDifference: Math.abs(taxDifference),
      recommended,
    };
  }, [
    annualCtc,
    basicSalary,
    annualRentPaid,
    isMetroCity,
    deduction80C,
    deduction80D,
    homeLoanInterest,
    npsContribution,
  ]);

  // --------------------------------------------------------------------------
  // Tab 2: Reimbursement Claims State
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Tab 3: HRA Rent Receipt Generator State
  // --------------------------------------------------------------------------
  const [employeeName, setEmployeeName] = React.useState("Abhishek Sharma");
  const [companyName, setCompanyName] = React.useState("Anutech Digital Pvt Ltd");
  const [landlordName, setLandlordName] = React.useState("Rajesh Kumar Verma");
  const [landlordPan, setLandlordPan] = React.useState("ABCDE1234F");
  const [landlordPhone, setLandlordPhone] = React.useState("9876543210");
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

  // --------------------------------------------------------------------------
  // Tab 4: Career & Document Vault State
  // --------------------------------------------------------------------------
  const [checkedDocs, setCheckedDocs] = React.useState<Record<string, boolean>>({
    f16: true,
    slips: true,
    uan: true,
    rent: true,
  });

  const toggleDoc = (id: string) => {
    setCheckedDocs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Top Banner & Module Identification */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-hairline">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-3xl font-semibold text-ink">Salaried Pro</h1>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
              Individual Career & Tax Hub
            </Badge>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              Free Forever Tier
            </Badge>
          </div>
          <p className="text-sm text-ink-3 mt-1.5 max-w-3xl">
            Designed exclusively for job holders & corporate employees. Compare Old vs New Tax Regime with FY 2025–26 rules, manage monthly company reimbursements, and generate 1-click HRA rent receipts.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/settings/modules">
            <Button variant="outline" size="sm" className="gap-2">
              <Icon name="package" size={14} />
              Modular Plugins
            </Button>
          </Link>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (activeTab === "claims") copyHrSummary();
              else if (activeTab === "receipts") window.print();
              else toast.success("Tax calculation is live and updates dynamically!");
            }}
          >
            {activeTab === "claims" ? "Export HR Claims" : activeTab === "receipts" ? "Print Rent Receipts" : "Tax Summary Live"}
          </Button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-hairline pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab("tax")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            activeTab === "tax"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="rupee" size={16} />
          Tax Regime Comparator (FY 2025–26)
        </button>

        <button
          onClick={() => setActiveTab("claims")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            activeTab === "claims"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="wallet" size={16} />
          Company Reimbursements ({claims.length})
        </button>

        <button
          onClick={() => setActiveTab("receipts")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            activeTab === "receipts"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="receipt" size={16} />
          HRA Rent Receipt Generator
        </button>

        <button
          onClick={() => setActiveTab("vault")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            activeTab === "vault"
              ? "bg-indigo-50 text-indigo-700 font-semibold"
              : "text-ink-2 hover:text-ink hover:bg-paper-2"
          }`}
        >
          <Icon name="file" size={16} />
          Career & Tax Vault
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: CTC & TAX REGIME COMPARATOR                                   */}
      {/* ==================================================================== */}
      {activeTab === "tax" && (
        <div className="space-y-6">
          {/* Dynamic Winner Recommendation Banner */}
          <div
            className={`p-5 rounded-lg border-2 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
              taxCalculations.recommended === "NEW"
                ? "bg-gradient-to-r from-emerald-50 via-paper to-emerald-50/20 border-emerald-300"
                : "bg-gradient-to-r from-indigo-50 via-paper to-indigo-50/20 border-indigo-300"
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
                  Algorithm Recommendation
                </span>
                <span className="text-xs text-ink-3">FY 2025–26 / Assessment Year 2026–27</span>
              </div>
              <h2 className="font-serif text-xl font-bold text-ink">
                {taxCalculations.recommended === "NEW"
                  ? `💡 You save ₹${taxCalculations.taxDifference.toLocaleString("en-IN")} per year with the New Tax Regime!`
                  : `💡 Old Tax Regime is better by ₹${taxCalculations.taxDifference.toLocaleString("en-IN")} due to your high HRA and deductions!`}
              </h2>
              <p className="text-xs text-ink-2">
                {taxCalculations.recommended === "NEW"
                  ? "Under Budget 2024–25 / FY 2025–26, the New Tax Regime offers standard deduction of ₹75,000 and lower tax brackets up to ₹15 LPA without locking funds in tax-saving instruments."
                  : "Your rent (HRA exemption ₹" +
                    taxCalculations.hraExemption.toLocaleString("en-IN") +
                    ") plus Section 80C/80D investments exceed the New Regime standard deduction benefit."}
              </p>
            </div>

            <div className="flex items-baseline gap-2 shrink-0">
              <div className="text-right">
                <span className="text-xs text-ink-3 block">Est. Take-Home Pay</span>
                <span className="text-2xl font-serif font-bold text-emerald-600">
                  ₹
                  {(taxCalculations.recommended === "NEW"
                    ? taxCalculations.newMonthlyInHand
                    : taxCalculations.oldMonthlyInHand
                  ).toLocaleString("en-IN")}
                </span>
                <span className="text-2xs text-ink-3 block">/ month</span>
              </div>
            </div>
          </div>

          {/* Calculator Input & Side-by-Side Outputs */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Inputs (5 Cols) */}
            <Card className="lg:col-span-5 p-5 space-y-4">
              <div className="border-b border-hairline pb-2">
                <h3 className="font-semibold text-ink text-sm">Your CTC & Deductions Profile</h3>
                <p className="text-xs text-ink-3">Enter figures as per your company CTC breakdown</p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-ink-2 block mb-1">
                    Annual Gross CTC (₹)
                  </label>
                  <input
                    type="number"
                    step="10000"
                    value={annualCtc}
                    onChange={(e) => setAnnualCtc(Number(e.target.value) || 0)}
                    className="w-full text-sm font-mono px-3 py-2 border rounded-md border-hairline bg-paper focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-2xs text-ink-3 mt-0.5 block">
                    e.g., ₹12,00,000 for 12 LPA package
                  </span>
                </div>

                <div>
                  <label className="text-xs font-medium text-ink-2 block mb-1">
                    Basic Salary Component (₹ / year)
                  </label>
                  <input
                    type="number"
                    step="10000"
                    value={basicSalary}
                    onChange={(e) => setBasicSalary(Number(e.target.value) || 0)}
                    className="w-full text-sm font-mono px-3 py-2 border rounded-md border-hairline bg-paper focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-2xs text-ink-3 mt-0.5 block">Usually 40%–50% of annual CTC</span>
                </div>

                <div className="pt-2 border-t border-hairline">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-ink-2">Annual House Rent Paid (₹)</label>
                    <label className="text-2xs text-indigo-600 flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isMetroCity}
                        onChange={(e) => setIsMetroCity(e.target.checked)}
                        className="rounded text-indigo-600"
                      />
                      Metro City (Delhi, Mumbai, Kolkata, Chennai)
                    </label>
                  </div>
                  <input
                    type="number"
                    step="5000"
                    value={annualRentPaid}
                    onChange={(e) => setAnnualRentPaid(Number(e.target.value) || 0)}
                    className="w-full text-sm font-mono px-3 py-2 border rounded-md border-hairline bg-paper focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-2xs text-ink-3 mt-0.5 block">
                    Calculated HRA Exemption: <b>₹{taxCalculations.hraExemption.toLocaleString("en-IN")}</b>
                  </span>
                </div>

                <div className="pt-2 border-t border-hairline space-y-2">
                  <span className="text-xs font-semibold text-ink block">
                    Optional Old Regime Deductions
                  </span>

                  <div>
                    <label className="text-xs text-ink-2 block mb-0.5">Section 80C (EPF, ELSS, PPF, LIC - Max 1.5L)</label>
                    <input
                      type="number"
                      step="5000"
                      value={deduction80C}
                      onChange={(e) => setDeduction80C(Number(e.target.value) || 0)}
                      className="w-full text-sm font-mono px-3 py-1.5 border rounded-md border-hairline bg-paper"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-ink-2 block mb-0.5">Section 80D (Health Insurance - Max 75k)</label>
                    <input
                      type="number"
                      step="2000"
                      value={deduction80D}
                      onChange={(e) => setDeduction80D(Number(e.target.value) || 0)}
                      className="w-full text-sm font-mono px-3 py-1.5 border rounded-md border-hairline bg-paper"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-ink-2 block mb-0.5">Home Loan (Sec 24b)</label>
                      <input
                        type="number"
                        step="5000"
                        value={homeLoanInterest}
                        onChange={(e) => setHomeLoanInterest(Number(e.target.value) || 0)}
                        className="w-full text-sm font-mono px-3 py-1.5 border rounded-md border-hairline bg-paper"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-ink-2 block mb-0.5">NPS (Sec 80CCD)</label>
                      <input
                        type="number"
                        step="5000"
                        value={npsContribution}
                        onChange={(e) => setNpsContribution(Number(e.target.value) || 0)}
                        className="w-full text-sm font-mono px-3 py-1.5 border rounded-md border-hairline bg-paper"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            {/* Right Comparison Display (7 Cols) */}
            <div className="lg:col-span-7 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Card 1: New Tax Regime */}
              <Card
                className={`p-5 flex flex-col justify-between border-2 ${
                  taxCalculations.recommended === "NEW" ? "border-emerald-500 bg-emerald-50/10" : "border-hairline"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between pb-3 border-b border-hairline">
                    <div>
                      <h4 className="font-semibold text-ink text-base">New Tax Regime</h4>
                      <span className="text-xs text-ink-3">Default FY 2025–26</span>
                    </div>
                    {taxCalculations.recommended === "NEW" && (
                      <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Recommended</Badge>
                    )}
                  </div>

                  <div className="mt-4 space-y-2.5 text-xs">
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Gross CTC:</span>
                      <span className="font-mono text-ink">₹{annualCtc.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Standard Deduction:</span>
                      <span className="font-mono text-emerald-700 font-semibold">- ₹75,000</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Net Taxable Income:</span>
                      <span className="font-mono text-ink font-semibold">
                        ₹{taxCalculations.newTaxableIncome.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Total Tax + Cess (4%):</span>
                      <span className="font-mono text-rose-600 font-bold">
                        ₹{taxCalculations.newTaxPayable.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-hairline bg-paper-2/40 -mx-5 -mb-5 p-5 rounded-b-lg">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <span className="text-xs text-ink-3 block">Monthly Take-Home</span>
                      <span className="text-xl font-serif font-bold text-ink">
                        ₹{taxCalculations.newMonthlyInHand.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-ink-3 block">Annual In-Hand</span>
                      <span className="text-sm font-mono font-semibold text-ink">
                        ₹{taxCalculations.newAnnualInHand.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Card 2: Old Tax Regime */}
              <Card
                className={`p-5 flex flex-col justify-between border-2 ${
                  taxCalculations.recommended === "OLD" ? "border-indigo-500 bg-indigo-50/10" : "border-hairline"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between pb-3 border-b border-hairline">
                    <div>
                      <h4 className="font-semibold text-ink text-base">Old Tax Regime</h4>
                      <span className="text-xs text-ink-3">With HRA & 80C Exemptions</span>
                    </div>
                    {taxCalculations.recommended === "OLD" && (
                      <Badge className="bg-indigo-600 text-white hover:bg-indigo-600">Recommended</Badge>
                    )}
                  </div>

                  <div className="mt-4 space-y-2.5 text-xs">
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Gross CTC:</span>
                      <span className="font-mono text-ink">₹{annualCtc.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Standard Deduction:</span>
                      <span className="font-mono text-ink-2">- ₹50,000</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">HRA Exemption:</span>
                      <span className="font-mono text-emerald-700">
                        - ₹{taxCalculations.hraExemption.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Total Deductions Claimed:</span>
                      <span className="font-mono text-emerald-700 font-semibold">
                        - ₹{taxCalculations.totalOldDeductions.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Net Taxable Income:</span>
                      <span className="font-mono text-ink font-semibold">
                        ₹{taxCalculations.oldTaxableIncome.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-hairline/50">
                      <span className="text-ink-3">Total Tax + Cess (4%):</span>
                      <span className="font-mono text-rose-600 font-bold">
                        ₹{taxCalculations.oldTaxPayable.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-hairline bg-paper-2/40 -mx-5 -mb-5 p-5 rounded-b-lg">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <span className="text-xs text-ink-3 block">Monthly Take-Home</span>
                      <span className="text-xl font-serif font-bold text-ink">
                        ₹{taxCalculations.oldMonthlyInHand.toLocaleString("en-IN")}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-ink-3 block">Annual In-Hand</span>
                      <span className="text-sm font-mono font-semibold text-ink">
                        ₹{taxCalculations.oldAnnualInHand.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: COMPANY REIMBURSEMENTS & CLAIMS                               */}
      {/* ==================================================================== */}
      {activeTab === "claims" && (
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
              <Button variant="outline" size="sm" onClick={copyHrSummary} className="gap-1.5">
                <Icon name="copy" size={14} />
                Copy for HR / Slack
              </Button>
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

          {/* Add Claim Modal / Form */}
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
                    <option value="Books & Courses">Books & Certifications</option>
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
                    <th className="p-3">Description & Receipt</th>
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

      {/* ==================================================================== */}
      {/* TAB 3: HRA RENT RECEIPT GENERATOR                                    */}
      {/* ==================================================================== */}
      {activeTab === "receipts" && (
        <div className="space-y-6">
          {/* Controls Bar */}
          <Card className="p-5 space-y-4">
            <div className="border-b border-hairline pb-2 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-sm text-ink">Rent Receipt Configuration (Section 10(13A))</h3>
                <p className="text-xs text-ink-3">Generate 12-month Income Tax-compliant rent receipts with Landlord PAN</p>
              </div>
              <Button variant="primary" size="sm" onClick={() => window.print()} className="gap-2">
                <Icon name="printer" size={14} />
                Print / Save PDF (12 Months)
              </Button>
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
      )}

      {/* ==================================================================== */}
      {/* TAB 4: CAREER & DOCUMENT VAULT                                       */}
      {/* ==================================================================== */}
      {activeTab === "vault" && (
        <div className="space-y-6">
          <Card className="p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-ink text-base">Salaried Professional Compliance Vault</h3>
              <p className="text-xs text-ink-3 mt-1">
                Keep your mandatory career and tax documents checklist up-to-date for your annual HR proof submission and ITR filing.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              {VAULT_CHECKLIST.map((item) => {
                const checked = !!checkedDocs[item.id];
                return (
                  <div
                    key={item.id}
                    onClick={() => toggleDoc(item.id)}
                    className={`p-3.5 rounded-lg border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                      checked
                        ? "bg-emerald-50/20 border-emerald-300"
                        : "bg-paper border-hairline hover:bg-paper-2"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                          checked
                            ? "bg-emerald-600 border-emerald-600 text-white"
                            : "border-zinc-300 bg-white"
                        }`}
                      >
                        {checked && <Icon name="check" size={12} />}
                      </div>
                      <div>
                        <span
                          className={`text-xs font-medium block ${
                            checked ? "text-ink font-semibold" : "text-ink-2"
                          }`}
                        >
                          {item.label}
                        </span>
                        <span className="text-2xs text-ink-3">{item.category}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {item.mandatory && (
                        <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                          Mandatory
                        </span>
                      )}
                      <span
                        className={`text-2xs px-2 py-0.5 rounded font-medium ${
                          checked ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {checked ? "Ready / Stored" : "Pending"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
