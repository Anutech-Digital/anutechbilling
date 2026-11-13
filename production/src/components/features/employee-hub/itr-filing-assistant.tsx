"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import {
  computeItr1,
  generateItr1Json,
  generateItr1TaxSummaryCsv,
  type Itr1Inputs,
} from "@/lib/tax/itr-salaried";

interface ItrFilingAssistantProps {
  initialSalaryGross?: number;
  initialOtherIncome?: number;
}

export function ItrFilingAssistant({
  initialSalaryGross = 1200000,
  initialOtherIncome = 24000,
}: ItrFilingAssistantProps) {
  // Personal Info
  const [pan, setPan] = React.useState("ABCDE1234F");
  const [fullName, setFullName] = React.useState("Abhishek Sharma");
  const [financialYear, setFinancialYear] = React.useState<"FY 2024-25" | "FY 2025-26">("FY 2024-25");
  const [employerType, setEmployerType] = React.useState<"Private" | "Government" | "PSU" | "Other">("Private");
  const [bankAccount, setBankAccount] = React.useState("XXXXXX1234");
  const [bankIfsc, setBankIfsc] = React.useState("HDFC0000123");

  // Salary & Exemptions
  const [grossSalary, setGrossSalary] = React.useState<number>(initialSalaryGross);
  const [exemptAllowances, setExemptAllowances] = React.useState<number>(120000); // HRA
  const [professionalTax, setProfessionalTax] = React.useState<number>(2400);

  // House Property
  const [propertyType, setPropertyType] = React.useState<"Self-Occupied" | "Let-Out" | "None">("None");
  const [homeLoanInterest, setHomeLoanInterest] = React.useState<number>(0);

  // Other Incomes
  const [savingsInterest, setSavingsInterest] = React.useState<number>(8500);
  const [depositInterest, setDepositInterest] = React.useState<number>(12000);
  const [dividendIncome, setDividendIncome] = React.useState<number>(3500);
  const [otherIncome, setOtherIncome] = React.useState<number>(0);

  // Chapter VI-A Deductions
  const [sec80C, setSec80C] = React.useState<number>(150000);
  const [sec80D_self, setSec80D_self] = React.useState<number>(25000);
  const [sec80D_parents, setSec80D_parents] = React.useState<number>(25000);
  const [sec80CCD_1B, setSec80CCD_1B] = React.useState<number>(50000);
  const [sec80G, setSec80G] = React.useState<number>(0);

  // Taxes Paid & TDS
  const [tdsOnSalary, setTdsOnSalary] = React.useState<number>(65000);
  const [tdsOnOther, setTdsOnOther] = React.useState<number>(1200);
  const [advanceTaxPaid, setAdvanceTaxPaid] = React.useState<number>(0);

  // Active regime toggle
  const [chosenRegime, setChosenRegime] = React.useState<"NEW" | "OLD">("NEW");

  // Current inputs object
  const currentInputs: Itr1Inputs = React.useMemo(() => {
    return {
      personal: {
        pan,
        fullName,
        financialYear,
        assessmentYear: financialYear === "FY 2024-25" ? "AY 2025-26" : "AY 2026-27",
        employerType,
        bankAccountNumber: bankAccount,
        bankIfsc,
      },
      salary: {
        grossSalary,
        exemptAllowances,
        professionalTax,
      },
      houseProperty: {
        propertyType,
        homeLoanInterest,
      },
      otherIncome: {
        savingsInterest,
        depositInterest,
        dividendIncome,
        otherIncome,
      },
      deductions: {
        sec80C,
        sec80D_self,
        sec80D_parents,
        sec80CCD_1B,
        sec80G,
      },
      taxesPaid: {
        tdsOnSalary,
        tdsOnOther,
        advanceTaxPaid,
      },
    };
  }, [
    pan,
    fullName,
    financialYear,
    employerType,
    bankAccount,
    bankIfsc,
    grossSalary,
    exemptAllowances,
    professionalTax,
    propertyType,
    homeLoanInterest,
    savingsInterest,
    depositInterest,
    dividendIncome,
    otherIncome,
    sec80C,
    sec80D_self,
    sec80D_parents,
    sec80CCD_1B,
    sec80G,
    tdsOnSalary,
    tdsOnOther,
    advanceTaxPaid,
  ]);

  // Tax computation
  const computationResult = React.useMemo(() => {
    return computeItr1(currentInputs, chosenRegime);
  }, [currentInputs, chosenRegime]);

  // Set default recommendation
  React.useEffect(() => {
    setChosenRegime(computationResult.recommendedRegime);
  }, [computationResult.recommendedRegime]);

  const activeComp = computationResult.activeComputation;

  // Handlers
  const handleDownloadJson = () => {
    const json = generateItr1Json(currentInputs, computationResult);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ITR1_${currentInputs.personal.pan}_${currentInputs.personal.assessmentYear.replace(/\s+/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("ITR-1 Sahaj JSON downloaded! You can upload this directly to incometax.gov.in");
  };

  const handleDownloadCsv = () => {
    const csv = generateItr1TaxSummaryCsv(currentInputs, computationResult);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Tax_Computation_${currentInputs.personal.pan}_${currentInputs.personal.assessmentYear.replace(/\s+/g, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Tax Computation summary sheet downloaded.");
  };

  return (
    <div className="space-y-6">
      {/* ── Top Summary & Regime Comparison Cards ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recommendation Card */}
        <Card className="p-4 border-2 border-indigo-200 bg-indigo-50/30 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-indigo-900">Tax Optimization Engine</span>
              <Badge variant="outline" className="bg-indigo-100 text-indigo-800 text-2xs">
                {computationResult.recommendedRegime === "NEW" ? "New Regime Wins" : "Old Regime Wins"}
              </Badge>
            </div>
            <div className="mt-2 text-2xl font-serif font-bold text-ink">
              Save ₹{computationResult.taxSavingsRupees.toLocaleString("en-IN")}
            </div>
            <p className="text-2xs text-ink-3 mt-1">
              By choosing the{" "}
              <b>{computationResult.recommendedRegime === "NEW" ? "New Tax Regime (Section 115BAC)" : "Old Tax Regime"}</b>,
              your total tax liability is reduced by ₹{computationResult.taxSavingsRupees.toLocaleString("en-IN")}.
            </p>
          </div>

          <div className="pt-3 border-t border-indigo-100 flex items-center gap-2">
            <button
              onClick={() => setChosenRegime("NEW")}
              className={`flex-1 text-xs py-1.5 rounded font-medium border text-center transition-colors ${
                chosenRegime === "NEW"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-paper border-hairline text-ink-2 hover:bg-paper-2"
              }`}
            >
              New Regime (₹{computationResult.newRegime.totalTaxLiability.toLocaleString("en-IN")})
            </button>
            <button
              onClick={() => setChosenRegime("OLD")}
              className={`flex-1 text-xs py-1.5 rounded font-medium border text-center transition-colors ${
                chosenRegime === "OLD"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-paper border-hairline text-ink-2 hover:bg-paper-2"
              }`}
            >
              Old Regime (₹{computationResult.oldRegime.totalTaxLiability.toLocaleString("en-IN")})
            </button>
          </div>
        </Card>

        {/* Tax Settlement Card (Refund or Demand) */}
        <Card
          className={`p-4 border-2 flex flex-col justify-between ${
            computationResult.isRefund
              ? "border-emerald-300 bg-emerald-50/30"
              : "border-amber-300 bg-amber-50/30"
          }`}
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink">
                {computationResult.isRefund ? "🟢 Income Tax Refund Due" : "🔴 Net Tax Payable"}
              </span>
              <span className="text-2xs font-mono bg-paper px-2 py-0.5 rounded border border-hairline">
                {currentInputs.personal.assessmentYear}
              </span>
            </div>
            <div
              className={`mt-2 text-3xl font-serif font-bold ${
                computationResult.isRefund ? "text-emerald-700" : "text-amber-800"
              }`}
            >
              ₹{computationResult.isRefund
                ? computationResult.refundAmount.toLocaleString("en-IN")
                : computationResult.balanceTaxPayable.toLocaleString("en-IN")}
            </div>
            <p className="text-2xs text-ink-3 mt-1">
              {computationResult.isRefund
                ? "Your employer/bank deducted excess TDS. This refund will be credited directly to your bank account!"
                : "Additional tax payable before filing ITR-1 via Challan 280 (Self-Assessment Tax)."}
            </p>
          </div>

          <div className="pt-3 border-t border-hairline flex items-center justify-between text-2xs text-ink-2">
            <span>Total TDS Paid: <b>₹{computationResult.totalTaxesPaid.toLocaleString("en-IN")}</b></span>
            <span>Liability: <b>₹{activeComp.totalTaxLiability.toLocaleString("en-IN")}</b></span>
          </div>
        </Card>

        {/* Direct Actions Card */}
        <Card className="p-4 border border-hairline flex flex-col justify-between space-y-3 bg-paper">
          <div>
            <h4 className="font-semibold text-xs text-ink">ITR-1 Sahaj Ready Actions</h4>
            <p className="text-2xs text-ink-3 mt-1">
              Download your verified tax return files or navigate to the official portal to complete e-filing in 2 minutes.
            </p>
          </div>

          <div className="space-y-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleDownloadJson}
              className="w-full gap-2 justify-center"
            >
              <Icon name="download" size={14} />
              Download ITR-1 JSON
            </Button>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCsv}
                className="flex-1 gap-1.5 justify-center text-xs"
              >
                <Icon name="file" size={13} />
                Tax Sheet (CSV)
              </Button>
              <a
                href="https://eportal.incometax.gov.in/"
                target="_blank"
                rel="noreferrer"
                className="flex-1"
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5 justify-center text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                >
                  <Icon name="external" size={13} />
                  e-Filing Portal
                </Button>
              </a>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Inputs & Computation Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Form 16 & Incomes */}
        <div className="space-y-6">
          <Card className="p-5 space-y-4 border-hairline">
            <div className="flex items-center justify-between border-b border-hairline pb-2">
              <div>
                <h3 className="font-semibold text-sm text-ink">1. Salary Details (From Form 16 Part B)</h3>
                <p className="text-xs text-ink-3">Section 17 gross salary and Section 10 exempt allowances</p>
              </div>
              <Badge variant="outline" className="text-2xs font-mono">
                {currentInputs.personal.financialYear}
              </Badge>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Gross Salary u/s 17(1) (₹)</label>
                  <input
                    type="number"
                    value={grossSalary}
                    onChange={(e) => setGrossSalary(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">HRA / LTA Exempt u/s 10 (₹)</label>
                  <input
                    type="number"
                    value={exemptAllowances}
                    onChange={(e) => setExemptAllowances(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Applicable only in Old Regime</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Professional Tax u/s 16(iii) (₹)</label>
                  <input
                    type="number"
                    value={professionalTax}
                    onChange={(e) => setProfessionalTax(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Standard Deduction u/s 16(ia)</label>
                  <div className="font-mono text-xs p-1.5 rounded bg-paper-2 font-medium">
                    {chosenRegime === "NEW" ? "₹75,000 (New Regime)" : "₹50,000 (Old Regime)"}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-5 space-y-4 border-hairline">
            <div className="flex items-center justify-between border-b border-hairline pb-2">
              <div>
                <h3 className="font-semibold text-sm text-ink">2. House Property & Other Sources</h3>
                <p className="text-xs text-ink-3">Housing loan interest and savings/deposit interest</p>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Home Loan Interest u/s 24(b)</label>
                  <input
                    type="number"
                    value={homeLoanInterest}
                    onChange={(e) => setHomeLoanInterest(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Max ₹2L deduction in Old Regime</span>
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Savings Bank Interest (₹)</label>
                  <input
                    type="number"
                    value={savingsInterest}
                    onChange={(e) => setSavingsInterest(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">80TTA exempt up to ₹10,000 (Old)</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">FD / Term Deposit Interest (₹)</label>
                  <input
                    type="number"
                    value={depositInterest}
                    onChange={(e) => setDepositInterest(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Dividends & Casual Income (₹)</label>
                  <input
                    type="number"
                    value={dividendIncome}
                    onChange={(e) => setDividendIncome(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column: Deductions, Taxes Paid & Summary */}
        <div className="space-y-6">
          <Card className="p-5 space-y-4 border-hairline">
            <div className="flex items-center justify-between border-b border-hairline pb-2">
              <div>
                <h3 className="font-semibold text-sm text-ink">3. Chapter VI-A Deductions (Old Regime)</h3>
                <p className="text-xs text-ink-3">80C, 80D, 80CCD(1B) NPS</p>
              </div>
              <Badge variant="outline" className="text-2xs">
                {chosenRegime === "OLD" ? "Active in Old Regime" : "Not available in New"}
              </Badge>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Sec 80C (EPF, PPF, ELSS, LIC)</label>
                  <input
                    type="number"
                    value={sec80C}
                    onChange={(e) => setSec80C(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Max allowed: ₹1,50,000</span>
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Sec 80CCD(1B) (NPS Tier 1)</label>
                  <input
                    type="number"
                    value={sec80CCD_1B}
                    onChange={(e) => setSec80CCD_1B(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Additional ₹50,000 limit</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Sec 80D (Self & Family Mediclaim)</label>
                  <input
                    type="number"
                    value={sec80D_self}
                    onChange={(e) => setSec80D_self(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Max ₹25,000</span>
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">Sec 80D (Parents Mediclaim)</label>
                  <input
                    type="number"
                    value={sec80D_parents}
                    onChange={(e) => setSec80D_parents(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                  <span className="text-3xs text-ink-3">Up to ₹50,000 for Senior Citizens</span>
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-5 space-y-4 border-hairline">
            <div className="flex items-center justify-between border-b border-hairline pb-2">
              <div>
                <h3 className="font-semibold text-sm text-ink">4. Taxes Paid & TDS Credits (Form 26AS / AIS)</h3>
                <p className="text-xs text-ink-3">TDS withheld by employer and bank</p>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-medium text-ink-2 block mb-1">TDS on Salary (Form 16 Part A)</label>
                  <input
                    type="number"
                    value={tdsOnSalary}
                    onChange={(e) => setTdsOnSalary(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
                <div>
                  <label className="font-medium text-ink-2 block mb-1">TDS on Bank Interest (Sec 194A)</label>
                  <input
                    type="number"
                    value={tdsOnOther}
                    onChange={(e) => setTdsOnOther(Number(e.target.value) || 0)}
                    className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                  />
                </div>
              </div>

              <div>
                <label className="font-medium text-ink-2 block mb-1">Advance Tax / Self-Assessment Tax Paid (₹)</label>
                <input
                  type="number"
                  value={advanceTaxPaid}
                  onChange={(e) => setAdvanceTaxPaid(Number(e.target.value) || 0)}
                  className="w-full font-mono text-xs px-3 py-1.5 border rounded border-hairline bg-paper"
                />
              </div>

              {/* Final Computation Breakdown */}
              <div className="pt-2 border-t border-hairline text-2xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-ink-3">Gross Total Income (GTI):</span>
                  <span className="font-mono font-medium text-ink">₹{activeComp.grossTotalIncome.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Total Deductions:</span>
                  <span className="font-mono font-medium text-ink">−₹{activeComp.totalDeductions.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Taxable Total Income:</span>
                  <span className="font-mono font-bold text-ink">₹{activeComp.taxableIncome.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Tax on Slabs:</span>
                  <span className="font-mono text-ink">₹{activeComp.taxOnSlabs.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Rebate u/s 87A:</span>
                  <span className="font-mono text-emerald-700">−₹{activeComp.rebate87A.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Health & Education Cess (4%):</span>
                  <span className="font-mono text-ink">₹{activeComp.cess.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex justify-between pt-1 border-t border-hairline font-semibold">
                  <span className="text-ink">Total Tax Liability:</span>
                  <span className="font-mono text-ink">₹{activeComp.totalTaxLiability.toLocaleString("en-IN")}</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
