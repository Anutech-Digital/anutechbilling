/**
 * R-2733 (Hitesh, 13 Nov 2026): the Employees table's "In-hand / month" and the CTC tab's
 * "Monthly Net Pay" are the net the Pay salary dialog works out — one function (net-pay.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computePf, pfWage } from "./pf";
import { computeEsi } from "./esi";
import { estimateMonthlyTds } from "./income-tax";
import {
  annualFromMonthlyCtc, basicFromPct, basicShareText, fyFirstPeriod, monthNetPay, monthlyFromAnnualCtc,
  payslipsByEmployee, salaryAutoDeductions,
} from "./net-pay";
import { applyStructureBlockedReason, ctcTabBreakdown } from "./ctc";
import type { SalaryRevision } from "./salary-revision";

describe("R-2733 (R-2727 item 4): Basic share on the CTC tab never reads above 100%", () => {
  it("Custom Basic 20,000 on CTC 1,20,000 (Prashant: 17,850 / Basic 10,000) → 'more than this CTC allows', same as the Apply reason", () => {
    const b = ctcTabBreakdown({
      ctcTyped: true, annualCtc: 120_000, gross: 17_850, basic: 10_000, da: 0,
      pfApplicable: true, esiApplicable: true, pfFullWage: false, includeGratuity: true, ctcIncludesEmployer: true,
      saved: { gross: 17_850, basic: 10_000, da: 0 }, keepSavedBasic: true,
      calc: { basicPct: 0.5, customBasicMonthly: 20_000 },
    });
    expect(b.monthlyCtc).toBe(10_000);
    expect(b.basicPct).toBeGreaterThan(1); // the raw share the old label printed as "200%"
    expect(basicShareText(b)).toBe("more than this CTC allows");
    expect(applyStructureBlockedReason(b, false)).toMatch(/^Basic is more than this CTC allows/);
  });

  it("a Basic inside the CTC keeps its percentage", () => {
    expect(basicShareText({ basicPct: 0.5, overBudget: false })).toBe("50%");
    expect(basicShareText({ basicPct: 1, overBudget: false })).toBe("100%");
    expect(basicShareText({ basicPct: 0.4, overBudget: true })).toBe("more than this CTC allows");
    expect(basicShareText({ basicPct: Number.NaN, overBudget: false })).toBe("more than this CTC allows");
  });

  it("the CTC tab's Basic line uses it (no raw basicPct × 100 left)", () => {
    const src = readFileSync(path.join(__dirname, "../../app/(app)/accounting/payroll/screens.tsx"), "utf8");
    expect(src).toContain("Basic Salary ({basicShareText(ctcBreakdown)}):");
    expect(src).not.toContain("Basic Salary ({Math.round(ctcBreakdown.basicPct * 100)}%)");
  });
});

const emp = (o: Partial<Parameters<typeof monthNetPay>[0]> = {}) => ({
  monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0,
  pf_applicable: true, esi_applicable: false, pf_full_wage: false, ...o,
});

describe("R-2733 monthNetPay = the net Pay salary works out (full month, nothing typed)", () => {
  it("30,000 / Basic 15,000, PF capped: net 28,200 (PF 1,800; no ESI above 21,000; TDS nil under 87A)", () => {
    const n = monthNetPay(emp(), [], "2026-11", []);
    expect(n).toMatchObject({ gross: 30_000, pf: 1_800, esi: 0, tds: 0, net: 28_200 });
    expect(n?.explain).toMatch(/^Full month: ₹28,200 = gross ₹30,000 − PF ₹1,800, as Pay salary/);
    expect(n?.explain).not.toMatch(/\bPT\b|Professional/);
  });

  it("is exactly the Pay salary dialog's own arithmetic (pfWage → computePf, computeEsi, estimateMonthlyTds)", () => {
    const history = [
      { period: "2026-04", gross: 300_000, lop_amount: 0, incentive: 0, tds: 9_000, esi: 0 },
      { period: "2026-05", gross: 300_000, lop_amount: 5_000, incentive: 2_000, tds: 9_000, esi: 0 },
      { period: "2025-12", gross: 150_000, lop_amount: 0, incentive: 0, tds: 99_999, esi: 0 }, // last FY — ignored
    ];
    const e = emp({ monthly_gross: 300_000, basic_monthly: 75_000, da_monthly: 2_000 });
    const n = monthNetPay(e, [], "2026-11", history)!;
    // The dialog, inline, as it was before R-2733 (screens.tsx PaySalaryDialog):
    const wage = pfWage({ gross: 300_000, lopAmount: 0, basic: 75_000, da: 2_000, monthlyGross: 300_000 });
    const pf = computePf(wage.base, true, "2026-11", { capped: true }).employee;
    const esi = computeEsi(300_000, false, false).employee;
    const tds = estimateMonthlyTds({
      period: "2026-11", thisMonthEarned: 300_000,
      earlier: history.map((p) => ({ period: p.period, earned: Math.max(0, p.gross - p.lop_amount) + p.incentive, tds: p.tds })),
      monthlyGrossAhead: 300_000,
    }).thisMonth;
    expect(pf).toBe(3_000); // PF wage ceiling ₹25,000 from Oct 2026 (owner's rule)
    expect(tds).toBeGreaterThan(0);
    expect(n).toMatchObject({ pf, esi, tds, net: 300_000 - pf - esi - tds });
  });

  it("PF basis full wage → 12% of Basic + DA (40,000 → 4,800); Basic not set → PF on the whole gross (capped)", () => {
    expect(monthNetPay(emp({ monthly_gross: 60_000, basic_monthly: 40_000, pf_full_wage: true }), [], "2026-11", [])?.pf).toBe(4_800);
    expect(monthNetPay(emp({ monthly_gross: 60_000, basic_monthly: 40_000 }), [], "2026-11", [])?.pf).toBe(3_000);
    expect(monthNetPay(emp({ monthly_gross: 20_000, basic_monthly: null }), [], "2026-11", [])?.pf).toBe(2_400);
    expect(monthNetPay(emp({ pf_applicable: false }), [], "2026-11", [])?.pf).toBe(0);
  });

  it("ESI cliff at ₹21,000 — and sticky inside the contribution period", () => {
    expect(monthNetPay(emp({ monthly_gross: 21_000, basic_monthly: 10_000, esi_applicable: true }), [], "2026-11", [])?.esi).toBe(158);
    expect(monthNetPay(emp({ monthly_gross: 21_001, basic_monthly: 10_000, esi_applicable: true }), [], "2026-11", [])?.esi).toBe(0);
    const coveredInOct = [{ period: "2026-10", gross: 20_000, esi: 150, tds: 0 }];
    expect(monthNetPay(emp({ monthly_gross: 21_001, basic_monthly: 10_000, esi_applicable: true }), [], "2026-11", coveredInOct)?.esi).toBe(158);
  });

  it("no PT: gross 30,000 net has no ₹200 PT (Pay salary deducts none by itself)", () => {
    const n = monthNetPay(emp({ pf_applicable: false }), [], "2026-11", [])!;
    expect(n.net).toBe(30_000);
  });

  it("a revision from next month → this month uses the salary in force (as Pay salary does)", () => {
    const rev: SalaryRevision = {
      id: "r1", employee_id: "e1", effective_from: "2026-12-01", monthly_gross: 40_000, basic_monthly: 20_000, da_monthly: 0,
      prev_monthly_gross: 30_000, prev_basic_monthly: 15_000, prev_da_monthly: 0, annual_ctc: null, note: null, created_by: null, created_at: "2026-11-01",
    };
    const e = emp({ monthly_gross: 40_000, basic_monthly: 20_000 });
    expect(monthNetPay(e, [rev], "2026-11", [])).toMatchObject({ gross: 30_000, pf: 1_800 });
    expect(monthNetPay(e, [rev], "2026-12", [])).toMatchObject({ gross: 40_000, pf: 2_400 });
  });

  it("no salary → null (the table shows —, never ₹0)", () => {
    expect(monthNetPay(emp({ monthly_gross: 0 }), [], "2026-11", [])).toBeNull();
  });

  it("salaryAutoDeductions on a prorated / LOP month matches the dialog's inline figures", () => {
    const a = salaryAutoDeductions({
      period: "2026-11", gross: 20_000, lopAmount: 2_000, extraEarned: 1_000, monthGross: 30_000,
      basic: 15_000, da: 0, pfApplicable: true, pfFullWage: false, esiApplicable: true, monthlyGrossAhead: 30_000, history: [],
    });
    expect(a.earned).toBe(19_000);
    expect(a.pf.employee).toBe(computePf(pfWage({ gross: 20_000, lopAmount: 2_000, basic: 15_000, da: 0, monthlyGross: 30_000 }).base, true, "2026-11").employee);
    expect(a.esi.employee).toBe(computeEsi(18_000, true).employee);
  });

  it("Pay salary dialog calls salaryAutoDeductions (one source — no inline PF / ESI / TDS left)", () => {
    const src = readFileSync(path.join(__dirname, "../../app/(app)/accounting/payroll/screens.tsx"), "utf8");
    const dialog = src.slice(src.indexOf("function PaySalaryDialog"), src.indexOf("async function submit", src.indexOf("function PaySalaryDialog")));
    expect(dialog).toContain("salaryAutoDeductions(");
    expect(dialog).not.toMatch(/computePf\(|computeEsi\(|estimateMonthlyTds\(/);
  });
});

describe("R-2733 helpers", () => {
  it("Monthly CTC 25,000 → Annual 3,00,000; Annual 3,00,001 → Monthly 25,000; blank / bad → blank", () => {
    expect(annualFromMonthlyCtc("25000")).toBe("300000");
    expect(monthlyFromAnnualCtc("300001")).toBe("25000");
    expect(annualFromMonthlyCtc("")).toBe("");
    expect(annualFromMonthlyCtc("-5")).toBe("");
    expect(monthlyFromAnnualCtc("abc")).toBe("");
  });

  it("Basic % with no CTC: 40% of 30,000 = 12,000; capped at gross − DA; no gross → null", () => {
    expect(basicFromPct(0.4, 30_000, 0)).toBe(12_000);
    expect(basicFromPct(1, 30_000, 5_000)).toBe(25_000);
    expect(basicFromPct(0.5, 0, 0)).toBeNull();
  });

  it("payslips grouped once by employee; FY start", () => {
    const m = payslipsByEmployee([{ employee_id: "a", period: "2026-04", gross: 1 }, { employee_id: "b", period: "2026-04", gross: 2 }, { employee_id: "a", period: "2026-05", gross: 3 }]);
    expect(m.get("a")?.length).toBe(2);
    expect(fyFirstPeriod("2026-11")).toBe("2026-04");
    expect(fyFirstPeriod("2027-02")).toBe("2026-04");
  });
});

describe("R-2733 review fixes (owner: PT does not apply; LOW 2-4)", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");
  const screens = read("../../app/(app)/accounting/payroll/screens.tsx");
  const register = read("../../app/(app)/accounting/salary-register/page.tsx");
  const drawer = read("../../components/features/payroll/employee-detail-drawer.tsx");

  it("1: CTC register + profile drawer show the shared net (no old PT-subtracting netTakeHome); no PT box on the CTC tab", () => {
    for (const src of [register, drawer]) {
      expect(src).toContain("monthNetPay(");
      expect(src).not.toMatch(/netTakeHomeMonthly|professionalTaxMonthly/);
    }
    expect(register).not.toContain("Prof. Tax (PT)");
    expect(screens).not.toContain('id="payroll-professional-tax-mo"');
    expect(screens).not.toMatch(/PT and other deductions/);
  });

  it("2: In-hand says it is a FULL month (Pay salary mid-month pre-fills days so far)", () => {
    expect(screens).toMatch(/title=\{`Full month of \$\{periodLabel\(inHandPeriod\)\}/);
    const n = monthNetPay(emp(), [], "2026-11", [])!;
    expect(n.explain.startsWith("Full month:")).toBe(true);
  });

  it("3: a Basic % picked before the gross is remembered and applied when the gross arrives", () => {
    const fn = screens.slice(screens.indexOf("function setBasicFromPct"), screens.indexOf("// For a NEW employee, suggest ESI"));
    // remembered BEFORE the "no gross yet" early return
    expect(fn.indexOf("setBasicPctOfGross(pct)")).toBeGreaterThan(-1);
    expect(fn.indexOf("setBasicPctOfGross(pct)")).toBeLessThan(fn.indexOf("if (b === null) return"));
    // R-2773: the gross box goes through basicForTypedGross, whose first rule is the picked %.
    expect(screens).toContain("setGross(e.target.value); basicForTypedGross(e.target.value);");
    expect(screens).toContain("if (basicPctOfGross !== null) { setBasicFromPct(basicPctOfGross, grossText, daText); return; }");
    // the rule it applies: 40% of a gross typed later
    expect(basicFromPct(0.4, 20_000, 0)).toBe(8_000);
  });

  it("4: clearing Custom Basic restores the Basic held just before it (a Statutory-tab Basic of this session), not the saved one", () => {
    expect(screens).toContain("if (typed && customBasic.trim() === \"\") setBasicBeforeCustom(basicMonthly);");
    expect(screens).toContain("setBasicMonthly(typed ? e.target.value : (basicBeforeCustom ?? ctcBase.basic));");
  });
});
