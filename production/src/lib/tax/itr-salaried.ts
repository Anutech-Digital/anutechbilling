/**
 * ITR-1 (Sahaj) Tax Filing Engine for Salaried Individuals.
 *
 * ─── ELIGIBILITY CRITERIA (Income Tax Act, 1961) ────────────────────────────
 * ITR-1 (Sahaj) can be filed by a resident individual whose total income ≤ ₹50,00,000:
 *   1. Income from Salary / Pension (Section 17)
 *   2. Income from One House Property (Section 24)
 *   3. Income from Other Sources (Interest on savings/FD, dividends)
 *   4. Agricultural income up to ₹5,000
 *
 * ─── TAX REGIMES (Finance Act 2024 / FY 2024-25 & Budget 2025 / FY 2025-26) ─
 *   New Regime (Section 115BAC):
 *     - Default regime since FY 2023-24
 *     - Standard Deduction: ₹75,000 (from FY 2025-26 / Finance Act 2024)
 *     - Rebate under Section 87A:
 *         * Up to ₹7,00,000 taxable income pays ₹0 tax (FY 2024-25)
 *         * Up to ₹12,00,000 taxable income pays ₹0 tax (FY 2025-26 proposed)
 *     - Health & Education Cess: 4%
 *
 *   Old Regime:
 *     - Slabs: 0-2.5L Nil, 2.5-5L 5%, 5-10L 20%, >10L 30%
 *     - Standard Deduction: ₹50,000
 *     - Section 80C: up to ₹1,50,000 (EPF, PPF, ELSS, LIC, Home loan principal)
 *     - Section 80D: up to ₹25,000 (Self) + up to ₹25,000/₹50,000 (Parents)
 *     - Section 80CCD(1B): up to ₹50,000 (NPS)
 *     - Section 80TTA: up to ₹10,000 (Savings bank interest)
 *     - Section 24(b): up to ₹2,00,000 (Self-occupied home loan interest)
 *     - Rebate under Section 87A: Nil tax up to ₹5,00,000 taxable income
 *     - Cess: 4%
 *
 * ─── RULE OF THUMB: WHOLE RUPEES (Workspace Rule 4) ─────────────────────────
 * All storage and calculations use whole rupees (integers).
 */

export interface Itr1SalaryDetails {
  /** Gross Salary as per Form 16 Part B / Section 17(1) */
  grossSalary: number;
  /** Section 10 exemptions (e.g. HRA u/s 10(13A), LTA u/s 10(5)) */
  exemptAllowances: number;
  /** Professional Tax paid u/s 16(iii) (usually ₹2,400–₹2,500/year) */
  professionalTax: number;
}

export interface Itr1HousePropertyDetails {
  propertyType: "Self-Occupied" | "Let-Out" | "None";
  /** Housing loan interest paid u/s 24(b) (max ₹2,00,000 deduction in Old Regime) */
  homeLoanInterest: number;
  /** Rent received (if let-out) */
  rentReceived?: number;
  /** Municipal taxes paid (if let-out) */
  municipalTaxes?: number;
}

export interface Itr1OtherIncomeDetails {
  /** Savings bank account interest (eligible for 80TTA deduction in Old Regime) */
  savingsInterest: number;
  /** Fixed Deposit (FD) / Recurring Deposit (RD) interest */
  depositInterest: number;
  /** Dividend income */
  dividendIncome: number;
  /** Any other casual income */
  otherIncome: number;
}

export interface Itr1DeductionsDetails {
  /** Section 80C: EPF, PPF, ELSS, LIC, Home loan principal (max ₹1,50,000) */
  sec80C: number;
  /** Section 80D (Self & Family Mediclaim, max ₹25,000) */
  sec80D_self: number;
  /** Section 80D (Parents Mediclaim, max ₹25,000 non-senior or ₹50,000 senior citizen) */
  sec80D_parents: number;
  /** Section 80CCD(1B) additional voluntary NPS (max ₹50,000) */
  sec80CCD_1B: number;
  /** Section 80G eligible donations */
  sec80G: number;
}

export interface Itr1TaxesPaidDetails {
  /** TDS deducted by employer as per Form 16 Part A / 26AS / AIS (Section 192) */
  tdsOnSalary: number;
  /** TDS on Bank Interest / Other (Section 194A / 194) */
  tdsOnOther: number;
  /** Advance Tax / Self-Assessment Tax paid (Challan 280) */
  advanceTaxPaid: number;
}

export interface Itr1PersonalDetails {
  pan: string;
  fullName: string;
  financialYear: "FY 2024-25" | "FY 2025-26";
  assessmentYear: "AY 2025-26" | "AY 2026-27";
  employerType: "Private" | "Government" | "PSU" | "Other";
  bankAccountNumber?: string;
  bankIfsc?: string;
}

export interface Itr1Inputs {
  personal: Itr1PersonalDetails;
  salary: Itr1SalaryDetails;
  houseProperty: Itr1HousePropertyDetails;
  otherIncome: Itr1OtherIncomeDetails;
  deductions: Itr1DeductionsDetails;
  taxesPaid: Itr1TaxesPaidDetails;
}

export interface RegimeTaxComputation {
  regime: "NEW" | "OLD";
  grossSalary: number;
  exemptAllowances: number;
  standardDeduction: number;
  professionalTax: number;
  netSalary: number;
  housePropertyIncomeLoss: number;
  otherIncome: number;
  grossTotalIncome: number;
  totalDeductions: number;
  taxableIncome: number;
  taxOnSlabs: number;
  rebate87A: number;
  taxAfterRebate: number;
  cess: number;
  totalTaxLiability: number;
}

export interface Itr1ComputationResult {
  newRegime: RegimeTaxComputation;
  oldRegime: RegimeTaxComputation;
  recommendedRegime: "NEW" | "OLD";
  taxSavingsRupees: number;
  selectedRegime: "NEW" | "OLD";
  activeComputation: RegimeTaxComputation;
  totalTaxesPaid: number;
  /** Positive means refund due to taxpayer; 0 or negative means tax is still due */
  netPayableOrRefund: number;
  isRefund: boolean;
  refundAmount: number;
  balanceTaxPayable: number;
  isItr1Eligible: boolean;
  eligibilityNotes: string[];
}

/**
 * Section 288A: Round taxable income to the nearest multiple of ten rupees.
 */
export function roundToNearestTen(amount: number): number {
  return Math.round(amount / 10) * 10;
}

/**
 * Core computation for Salaried ITR-1 (Sahaj).
 * Calculates both New and Old regimes and compares liability.
 */
export function computeItr1(inputs: Itr1Inputs, preferredRegime?: "NEW" | "OLD"): Itr1ComputationResult {
  const isFY2526 = inputs.personal.financialYear === "FY 2025-26";

  // 1. Incomes
  const grossSalary = Math.max(0, Math.round(inputs.salary.grossSalary || 0));
  const exemptAllowances = Math.max(0, Math.round(inputs.salary.exemptAllowances || 0));
  const professionalTax = Math.min(2500, Math.max(0, Math.round(inputs.salary.professionalTax || 0)));

  const totalOtherIncome = Math.max(
    0,
    Math.round(
      (inputs.otherIncome.savingsInterest || 0) +
      (inputs.otherIncome.depositInterest || 0) +
      (inputs.otherIncome.dividendIncome || 0) +
      (inputs.otherIncome.otherIncome || 0)
    )
  );

  // House Property
  let housePropertyLossOld = 0;
  if (inputs.houseProperty.propertyType === "Self-Occupied") {
    // Max ₹2,00,000 loss allowed to be set off in Old Regime
    housePropertyLossOld = -Math.min(200000, Math.max(0, Math.round(inputs.houseProperty.homeLoanInterest || 0)));
  } else if (inputs.houseProperty.propertyType === "Let-Out") {
    const rent = Math.max(0, Math.round(inputs.houseProperty.rentReceived || 0));
    const muni = Math.max(0, Math.round(inputs.houseProperty.municipalTaxes || 0));
    const netAnnualValue = Math.max(0, rent - muni);
    const standard30 = Math.round(netAnnualValue * 0.3);
    const interest = Math.max(0, Math.round(inputs.houseProperty.homeLoanInterest || 0));
    housePropertyLossOld = netAnnualValue - standard30 - interest;
  }
  // In New Regime, loss under house property cannot be set off against salary
  const housePropertyLossNew = housePropertyLossOld > 0 ? housePropertyLossOld : 0;

  // ──────────────────────────────────────────────────────────────────────────
  // A. NEW REGIME (Section 115BAC)
  // ──────────────────────────────────────────────────────────────────────────
  // Standard Deduction: ₹75,000
  const newStdDeduction = Math.min(grossSalary, 75000);
  const newNetSalary = Math.max(0, grossSalary - newStdDeduction);
  const newGrossTotalIncome = newNetSalary + housePropertyLossNew + totalOtherIncome;
  // In New Regime, chapter VI-A deductions are not allowable
  const newTaxableIncome = roundToNearestTen(newGrossTotalIncome);

  // New Slabs
  let newTaxBeforeRebate = 0;
  if (isFY2526) {
    // FY 2025-26 Slabs:
    // 0-4L Nil | 4-8L 5% | 8-12L 10% | 12-16L 15% | 16-20L 20% | 20-24L 25% | >24L 30%
    if (newTaxableIncome > 400000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 800000) - 400000) * 0.05;
    if (newTaxableIncome > 800000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 1200000) - 800000) * 0.10;
    if (newTaxableIncome > 1200000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 1600000) - 1200000) * 0.15;
    if (newTaxableIncome > 1600000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 2000000) - 1600000) * 0.20;
    if (newTaxableIncome > 2000000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 2400000) - 2000000) * 0.25;
    if (newTaxableIncome > 2400000) newTaxBeforeRebate += (newTaxableIncome - 2400000) * 0.30;
  } else {
    // FY 2024-25 Slabs:
    // 0-3L Nil | 3-7L 5% | 7-10L 10% | 10-12L 15% | 12-15L 20% | >15L 30%
    if (newTaxableIncome > 300000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 700000) - 300000) * 0.05;
    if (newTaxableIncome > 700000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 1000000) - 700000) * 0.10;
    if (newTaxableIncome > 1000000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 1200000) - 1000000) * 0.15;
    if (newTaxableIncome > 1200000) newTaxBeforeRebate += (Math.min(newTaxableIncome, 1500000) - 1200000) * 0.20;
    if (newTaxableIncome > 1500000) newTaxBeforeRebate += (newTaxableIncome - 1500000) * 0.30;
  }
  newTaxBeforeRebate = Math.round(newTaxBeforeRebate);

  // Section 87A Rebate for New Regime:
  // FY 2024-25: Nil tax up to ₹7,00,000 taxable income
  // FY 2025-26: Nil tax up to ₹12,00,000 taxable income
  const newRebateLimit = isFY2526 ? 1200000 : 700000;
  let newRebate87A = 0;
  if (newTaxableIncome <= newRebateLimit) {
    newRebate87A = newTaxBeforeRebate;
  } else if (newTaxableIncome > newRebateLimit && newTaxableIncome <= newRebateLimit + 50000) {
    // Marginal relief
    const excessIncome = newTaxableIncome - newRebateLimit;
    if (newTaxBeforeRebate > excessIncome) {
      newRebate87A = newTaxBeforeRebate - excessIncome;
    }
  }

  const newTaxAfterRebate = Math.max(0, newTaxBeforeRebate - newRebate87A);
  const newCess = Math.round(newTaxAfterRebate * 0.04);
  const newTotalTaxLiability = newTaxAfterRebate + newCess;

  const newComputation: RegimeTaxComputation = {
    regime: "NEW",
    grossSalary,
    exemptAllowances: 0, // not exempt under new regime
    standardDeduction: newStdDeduction,
    professionalTax: 0,
    netSalary: newNetSalary,
    housePropertyIncomeLoss: housePropertyLossNew,
    otherIncome: totalOtherIncome,
    grossTotalIncome: newGrossTotalIncome,
    totalDeductions: 0,
    taxableIncome: newTaxableIncome,
    taxOnSlabs: newTaxBeforeRebate,
    rebate87A: newRebate87A,
    taxAfterRebate: newTaxAfterRebate,
    cess: newCess,
    totalTaxLiability: newTotalTaxLiability,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // B. OLD REGIME
  // ──────────────────────────────────────────────────────────────────────────
  // Standard Deduction: ₹50,000
  const oldStdDeduction = Math.min(grossSalary, 50000);
  const oldSalaryAfterExempt = Math.max(0, grossSalary - exemptAllowances);
  const oldNetSalary = Math.max(0, oldSalaryAfterExempt - oldStdDeduction - professionalTax);

  const oldGrossTotalIncome = Math.max(0, oldNetSalary + housePropertyLossOld + totalOtherIncome);

  // Chapter VI-A Deductions
  const c80C = Math.min(150000, Math.max(0, Math.round(inputs.deductions.sec80C || 0)));
  const c80D_self = Math.min(25000, Math.max(0, Math.round(inputs.deductions.sec80D_self || 0)));
  const c80D_parents = Math.min(50000, Math.max(0, Math.round(inputs.deductions.sec80D_parents || 0)));
  const c80CCD_1B = Math.min(50000, Math.max(0, Math.round(inputs.deductions.sec80CCD_1B || 0)));
  const c80TTA = Math.min(10000, Math.max(0, Math.round(inputs.otherIncome.savingsInterest || 0)));
  const c80G = Math.max(0, Math.round(inputs.deductions.sec80G || 0));

  const totalOldDeductions = Math.min(
    oldGrossTotalIncome,
    c80C + c80D_self + c80D_parents + c80CCD_1B + c80TTA + c80G
  );

  const oldTaxableIncome = roundToNearestTen(Math.max(0, oldGrossTotalIncome - totalOldDeductions));

  // Old Slabs:
  // 0-2.5L Nil | 2.5-5L 5% | 5-10L 20% | >10L 30%
  let oldTaxBeforeRebate = 0;
  if (oldTaxableIncome > 250000) oldTaxBeforeRebate += (Math.min(oldTaxableIncome, 500000) - 250000) * 0.05;
  if (oldTaxableIncome > 500000) oldTaxBeforeRebate += (Math.min(oldTaxableIncome, 1000000) - 500000) * 0.20;
  if (oldTaxableIncome > 1000000) oldTaxBeforeRebate += (oldTaxableIncome - 1000000) * 0.30;
  oldTaxBeforeRebate = Math.round(oldTaxBeforeRebate);

  // Section 87A Rebate for Old Regime: Nil tax up to ₹5,00,000 taxable income
  let oldRebate87A = 0;
  if (oldTaxableIncome <= 500000) {
    oldRebate87A = oldTaxBeforeRebate;
  }

  const oldTaxAfterRebate = Math.max(0, oldTaxBeforeRebate - oldRebate87A);
  const oldCess = Math.round(oldTaxAfterRebate * 0.04);
  const oldTotalTaxLiability = oldTaxAfterRebate + oldCess;

  const oldComputation: RegimeTaxComputation = {
    regime: "OLD",
    grossSalary,
    exemptAllowances,
    standardDeduction: oldStdDeduction,
    professionalTax,
    netSalary: oldNetSalary,
    housePropertyIncomeLoss: housePropertyLossOld,
    otherIncome: totalOtherIncome,
    grossTotalIncome: oldGrossTotalIncome,
    totalDeductions: totalOldDeductions,
    taxableIncome: oldTaxableIncome,
    taxOnSlabs: oldTaxBeforeRebate,
    rebate87A: oldRebate87A,
    taxAfterRebate: oldTaxAfterRebate,
    cess: oldCess,
    totalTaxLiability: oldTotalTaxLiability,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Recommendation & Selected Regime
  // ──────────────────────────────────────────────────────────────────────────
  const recommendedRegime: "NEW" | "OLD" =
    newTotalTaxLiability <= oldTotalTaxLiability ? "NEW" : "OLD";
  const taxSavingsRupees = Math.abs(oldTotalTaxLiability - newTotalTaxLiability);

  const selectedRegime = preferredRegime || recommendedRegime;
  const activeComputation = selectedRegime === "NEW" ? newComputation : oldComputation;

  // Total Taxes Paid
  const totalTaxesPaid = Math.max(
    0,
    Math.round(
      (inputs.taxesPaid.tdsOnSalary || 0) +
      (inputs.taxesPaid.tdsOnOther || 0) +
      (inputs.taxesPaid.advanceTaxPaid || 0)
    )
  );

  const netPayableOrRefund = totalTaxesPaid - activeComputation.totalTaxLiability;
  const isRefund = netPayableOrRefund > 0;
  const refundAmount = isRefund ? netPayableOrRefund : 0;
  const balanceTaxPayable = !isRefund ? Math.abs(netPayableOrRefund) : 0;

  // ITR-1 Eligibility Check
  const eligibilityNotes: string[] = [];
  let isItr1Eligible = true;

  if (activeComputation.grossTotalIncome > 5000000) {
    isItr1Eligible = false;
    eligibilityNotes.push("Total income exceeds ₹50 Lakhs limit for ITR-1 (Sahaj). You need to file ITR-2.");
  }

  return {
    newRegime: newComputation,
    oldRegime: oldComputation,
    recommendedRegime,
    taxSavingsRupees,
    selectedRegime,
    activeComputation,
    totalTaxesPaid,
    netPayableOrRefund,
    isRefund,
    refundAmount,
    balanceTaxPayable,
    isItr1Eligible,
    eligibilityNotes,
  };
}

/**
 * Generates an official ITR-1 Sahaj e-Filing compatible JSON object.
 * Ready for direct validation or upload to https://eportal.incometax.gov.in/
 */
export function generateItr1Json(inputs: Itr1Inputs, result: Itr1ComputationResult) {
  const c = result.activeComputation;
  return {
    ITR: {
      ITR1: {
        Form_ITR1: {
          FormName: "ITR-1",
          Description: "Sahaj - For Individual having Income from Salary, One House Property, Other Sources",
          AssessmentYear: inputs.personal.assessmentYear.replace("AY ", ""),
          FinancialYear: inputs.personal.financialYear.replace("FY ", ""),
        },
        PersonalInfo: {
          PAN: inputs.personal.pan.toUpperCase(),
          AssesseeName: inputs.personal.fullName,
          EmployerCategory: inputs.personal.employerType,
          BankAccount: {
            AccountNumber: inputs.personal.bankAccountNumber || "XXXXXX1234",
            IFSC: inputs.personal.bankIfsc || "HDFC0000123",
          },
        },
        FilingStatus: {
          ReturnFileSec: "11", // 139(1) On or before due date
          OptingInNewRegime: c.regime === "NEW" ? "Y" : "N",
        },
        IncomeDeductions: {
          GrossSalary: c.grossSalary,
          SalaryExemptAllowances: c.exemptAllowances,
          StandardDeduction: c.standardDeduction,
          ProfessionalTax: c.professionalTax,
          NetSalary: c.netSalary,
          IncomeFromOneHouseProperty: c.housePropertyIncomeLoss,
          IncomeFromOtherSources: c.otherIncome,
          GrossTotalIncome: c.grossTotalIncome,
          TotalDeductions: c.totalDeductions,
          TotalTaxableIncome: c.taxableIncome,
        },
        TaxComputation: {
          TotalTaxPayable: c.taxOnSlabs,
          Rebate87A: c.rebate87A,
          TaxPayableOnRebate: c.taxAfterRebate,
          EducationCess: c.cess,
          TotalTaxLiability: c.totalTaxLiability,
        },
        TaxPaid: {
          TaxesPaid: {
            AdvanceTax: inputs.taxesPaid.advanceTaxPaid || 0,
            TDSSalary: inputs.taxesPaid.tdsOnSalary || 0,
            TDSOther: inputs.taxesPaid.tdsOnOther || 0,
            TotalTaxesPaid: result.totalTaxesPaid,
          },
        },
        Refund: {
          RefundDue: result.refundAmount,
          BalanceTaxPayable: result.balanceTaxPayable,
        },
        Verification: {
          Declaration: "I hereby declare that the particulars given are true, correct and complete.",
          Date: new Date().toISOString().split("T")[0],
          Place: "India",
        },
      },
    },
  };
}

/**
 * Generates clean CSV rows for the Salaried Tax Computation sheet.
 */
export function generateItr1TaxSummaryCsv(inputs: Itr1Inputs, result: Itr1ComputationResult): string {
  const c = result.activeComputation;
  const rows: (string | number)[][] = [
    ["ITR-1 (Sahaj) Tax Computation Sheet", inputs.personal.assessmentYear, inputs.personal.financialYear],
    ["Taxpayer Name", inputs.personal.fullName, `PAN: ${inputs.personal.pan}`],
    ["Tax Regime Selected", c.regime === "NEW" ? "New Tax Regime (Section 115BAC)" : "Old Tax Regime"],
    ["", "", ""],
    ["A. Salary Income (Section 17)", "Amount (₹)", "Notes / Section"],
    ["Gross Salary u/s 17(1)", c.grossSalary, "From Form 16 Part B"],
    ["Less: Allowances exempt u/s 10 (HRA etc.)", -c.exemptAllowances, c.regime === "NEW" ? "Not exempt in New Regime" : "Sec 10(13A)"],
    ["Less: Standard Deduction u/s 16(ia)", -c.standardDeduction, c.regime === "NEW" ? "₹75,000 (Budget 2024/25)" : "₹50,000"],
    ["Less: Professional Tax u/s 16(iii)", -c.professionalTax, "State PT"],
    ["Net Salary", c.netSalary, ""],
    ["", "", ""],
    ["B. House Property & Other Income", "Amount (₹)", "Notes"],
    ["Income / (Loss) from House Property", c.housePropertyIncomeLoss, "Sec 24(b) Home Loan Interest"],
    ["Income from Other Sources (Interest / Dividends)", c.otherIncome, "Savings & FD Interest"],
    ["Gross Total Income (GTI)", c.grossTotalIncome, "A + B"],
    ["", "", ""],
    ["C. Chapter VI-A Deductions", "Amount (₹)", "Allowed Limits"],
    ["Total Chapter VI-A Deductions", -c.totalDeductions, c.regime === "NEW" ? "Nil in New Regime" : "80C, 80D, 80CCD, 80TTA"],
    ["Taxable Total Income (Rounded u/s 288A)", c.taxableIncome, "Base for Tax Slabs"],
    ["", "", ""],
    ["D. Tax Liability & Rebate", "Amount (₹)", "Rates"],
    ["Tax calculated on Slabs", c.taxOnSlabs, "Applicable Slab Rates"],
    ["Less: Tax Rebate u/s 87A", -c.rebate87A, "Nil tax rebate"],
    ["Health & Education Cess (4%)", c.cess, "4% on Tax after rebate"],
    ["Total Tax Liability", c.totalTaxLiability, ""],
    ["", "", ""],
    ["E. Taxes Paid & Final Settlement", "Amount (₹)", "Status"],
    ["TDS on Salary (Form 16 Part A)", inputs.taxesPaid.tdsOnSalary, "Employer TDS"],
    ["TDS on Other Income (26AS / AIS)", inputs.taxesPaid.tdsOnOther, "Bank FD TDS"],
    ["Advance / Self-Assessment Tax Paid", inputs.taxesPaid.advanceTaxPaid, "Challan 280"],
    ["Total Taxes Paid", result.totalTaxesPaid, ""],
    [result.isRefund ? "NET REFUND DUE TO TAXPAYER" : "BALANCE TAX PAYABLE", result.isRefund ? result.refundAmount : result.balanceTaxPayable, result.isRefund ? "Refund via Direct Bank Credit" : "Pay via Challan 280"],
  ];

  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(",")
    )
    .join("\n");
}
