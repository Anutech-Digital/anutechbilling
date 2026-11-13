import { describe, it, expect } from "vitest";
import {
  computeItr1,
  generateItr1Json,
  generateItr1TaxSummaryCsv,
  roundToNearestTen,
  type Itr1Inputs,
} from "./itr-salaried";

const BASE_INPUTS: Itr1Inputs = {
  personal: {
    pan: "ABCDE1234F",
    fullName: "Aakash Mehta",
    financialYear: "FY 2024-25",
    assessmentYear: "AY 2025-26",
    employerType: "Private",
    bankAccountNumber: "123456789012",
    bankIfsc: "HDFC0000001",
  },
  salary: {
    grossSalary: 1200000, // 12 LPA
    exemptAllowances: 120000, // HRA
    professionalTax: 2400,
  },
  houseProperty: {
    propertyType: "None",
    homeLoanInterest: 0,
  },
  otherIncome: {
    savingsInterest: 8500,
    depositInterest: 12000,
    dividendIncome: 0,
    otherIncome: 0,
  },
  deductions: {
    sec80C: 150000,
    sec80D_self: 25000,
    sec80D_parents: 25000,
    sec80CCD_1B: 50000,
    sec80G: 0,
  },
  taxesPaid: {
    tdsOnSalary: 75000,
    tdsOnOther: 1200,
    advanceTaxPaid: 0,
  },
};

describe("itr-salaried tax calculations", () => {
  it("rounds taxable income to nearest 10 as per Section 288A", () => {
    expect(roundToNearestTen(543214)).toBe(543210);
    expect(roundToNearestTen(543216)).toBe(543220);
    expect(roundToNearestTen(543215)).toBe(543220);
  });

  it("calculates Section 87A rebate for income below threshold (zero tax)", () => {
    const lowIncomeInputs: Itr1Inputs = {
      ...BASE_INPUTS,
      salary: {
        grossSalary: 700000, // 7 LPA
        exemptAllowances: 0,
        professionalTax: 0,
      },
      otherIncome: {
        savingsInterest: 0,
        depositInterest: 0,
        dividendIncome: 0,
        otherIncome: 0,
      },
    };

    const res = computeItr1(lowIncomeInputs);
    // In New Regime with ₹75k standard deduction, taxable income is ₹6,25,000 (≤ 7L threshold)
    expect(res.newRegime.taxableIncome).toBe(625000);
    expect(res.newRegime.taxAfterRebate).toBe(0);
    expect(res.newRegime.totalTaxLiability).toBe(0);
  });

  it("correctly identifies refund when TDS paid exceeds total tax liability", () => {
    const inputs: Itr1Inputs = {
      ...BASE_INPUTS,
      salary: {
        grossSalary: 900000, // 9 LPA
        exemptAllowances: 0,
        professionalTax: 0,
      },
      taxesPaid: {
        tdsOnSalary: 50000,
        tdsOnOther: 0,
        advanceTaxPaid: 0,
      },
    };

    const res = computeItr1(inputs, "NEW");
    expect(res.totalTaxesPaid).toBe(50000);
    expect(res.isRefund).toBe(true);
    expect(res.refundAmount).toBe(50000 - res.activeComputation.totalTaxLiability);
  });

  it("generates valid ITR-1 Sahaj JSON object with required tax nodes", () => {
    const res = computeItr1(BASE_INPUTS);
    const json = generateItr1Json(BASE_INPUTS, res);

    expect(json.ITR.ITR1.Form_ITR1.FormName).toBe("ITR-1");
    expect(json.ITR.ITR1.PersonalInfo.PAN).toBe("ABCDE1234F");
    expect(json.ITR.ITR1.IncomeDeductions.GrossSalary).toBe(1200000);
    expect(json.ITR.ITR1.TaxPaid.TaxesPaid.TotalTaxesPaid).toBe(76200);
  });

  it("generates CSV computation sheet with all breakdown rows", () => {
    const res = computeItr1(BASE_INPUTS);
    const csv = generateItr1TaxSummaryCsv(BASE_INPUTS, res);

    expect(csv).toContain("ITR-1 (Sahaj) Tax Computation Sheet");
    expect(csv).toContain("Gross Salary u/s 17(1)");
    expect(csv).toContain("Standard Deduction u/s 16(ia)");
    expect(csv).toContain("Total Taxes Paid");
  });
});
