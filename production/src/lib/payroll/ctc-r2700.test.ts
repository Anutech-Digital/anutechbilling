/**
 * R-2700 — CTC fills the Monthly Gross by the company policy; the tab shows the SAVED gross
 * until a CTC is typed (R-2698 note: 30,000 showed as 31,347).
 */
import { describe, it, expect } from "vitest";
import { calculateCtcBreakdown, ctcFromEmployee, ctcTabBreakdown, ctcFormulaText, type CtcTabInput } from "./ctc";

const NOV = "2026-11"; // PF ceiling ₹25,000 from Oct 2026 (pf.ts)
const base: CtcTabInput = {
  ctcTyped: true, annualCtc: 360_000, gross: 0, basic: null, da: 0,
  pfApplicable: true, esiApplicable: true, pfFullWage: false, includeGratuity: true, ctcIncludesEmployer: true,
  calc: { asOf: NOV },
};
const costFits = (b: ReturnType<typeof ctcTabBreakdown>) =>
  b.grossMonthly + b.employerPfMonthly + b.employerEsiMonthly + b.gratuityMonthly;

describe("R-2700 CTC includes employer PF / ESI / gratuity (default policy)", () => {
  it("CTC 3,60,000 → gross 27,479 (30,000 − PF 1,800 − gratuity 721)", () => {
    const b = ctcTabBreakdown(base);
    expect(b.source).toBe("ctc");
    expect(b.monthlyCtc).toBe(30_000);
    expect(b.basicMonthly).toBe(15_000);
    expect(b.employerPfMonthly).toBe(1_800);
    expect(b.gratuityMonthly).toBe(721);
    expect(b.employerEsiMonthly).toBe(0); // 27,479 > ₹21,000
    expect(b.grossMonthly).toBe(27_479);
    expect(b.unallocatedMonthly).toBe(0);
    expect(b.employerOnTop).toBe(false);
    expect(ctcFormulaText(b)).toBe("Monthly gross ₹27,479 = CTC ₹3,60,000 ÷ 12 (₹30,000) − employer PF ₹1,800 − gratuity ₹721.");
  });

  it("low CTC 2,40,000 with ESI → gross ≤ ₹21,000 and gross + employer parts never above CTC/12", () => {
    const b = ctcTabBreakdown({ ...base, annualCtc: 240_000 });
    expect(b.grossMonthly).toBeLessThanOrEqual(21_000);
    expect(b.employerEsiMonthly).toBeGreaterThan(0);
    expect(costFits(b)).toBeLessThanOrEqual(b.monthlyCtc);
    expect(b.monthlyCtc - costFits(b)).toBeLessThanOrEqual(1);
    expect(b.grossMonthly).toBe(17_742);
  });

  it("CTC not divisible by 12 → monthly rounded, still fits", () => {
    for (const annualCtc of [350_005, 251_111, 199_999, 1_234_567]) {
      const b = ctcTabBreakdown({ ...base, annualCtc });
      expect(b.monthlyCtc).toBe(Math.round(annualCtc / 12));
      expect(costFits(b)).toBeLessThanOrEqual(b.monthlyCtc);
      expect(b.unallocatedMonthly).toBeGreaterThanOrEqual(0);
      expect(b.unallocatedMonthly).toBeLessThanOrEqual(1);
    }
  });

  it("PF / ESI off → only gratuity comes out of the CTC", () => {
    const b = ctcTabBreakdown({ ...base, pfApplicable: false, esiApplicable: false });
    expect(b.employerPfMonthly).toBe(0);
    expect(b.grossMonthly).toBe(30_000 - 721);
  });

  it("gratuity policy off → no gratuity", () => {
    const b = ctcTabBreakdown({ ...base, includeGratuity: false });
    expect(b.gratuityMonthly).toBe(0);
    expect(b.grossMonthly).toBe(30_000 - 1_800);
  });
});

describe("R-2700 CTC excludes employer costs (policy: they are on top)", () => {
  it("CTC 3,60,000 → gross 30,000 exactly; PF 1,800 + gratuity 721 on top", () => {
    const b = ctcTabBreakdown({ ...base, ctcIncludesEmployer: false });
    expect(b.grossMonthly).toBe(30_000);
    expect(b.basicMonthly).toBe(15_000);
    expect(b.employerOnTop).toBe(true);
    expect(b.costToCompanyMonthly).toBe(32_521);
    expect(b.unallocatedMonthly).toBe(0);
    expect(ctcFormulaText(b)).toBe("Monthly gross ₹30,000 = CTC ₹3,60,000 ÷ 12. On top: employer PF ₹1,800 + gratuity ₹721 (cost ₹32,521/mo).");
  });
  it("low gross with ESI on top: ESI on the gross (≤ ₹21,000)", () => {
    const b = ctcTabBreakdown({ ...base, ctcIncludesEmployer: false, annualCtc: 240_000 });
    expect(b.grossMonthly).toBe(20_000);
    expect(b.employerEsiMonthly).toBe(650); // ceil(20,000 × 3.25%)
    expect(b.employeeEsiMonthly).toBe(150);
  });
});

describe("R-2700 PF ceiling (₹25,000 from Oct 2026, pf.ts)", () => {
  it("Basic 40,000 capped → PF 3,000; full Basic + DA → 4,800", () => {
    const calc = { asOf: NOV, customBasicMonthly: 40_000 };
    expect(ctcTabBreakdown({ ...base, annualCtc: 1_200_000, calc }).employerPfMonthly).toBe(3_000);
    expect(ctcTabBreakdown({ ...base, annualCtc: 1_200_000, calc, pfFullWage: true }).employerPfMonthly).toBe(4_800);
  });
});

describe("R-2700 edge input", () => {
  it.each([0, -50_000, Number.NaN])("CTC %s → gross 0, no NaN, line asks for the CTC", (annualCtc) => {
    const b = ctcTabBreakdown({ ...base, annualCtc });
    expect(b.grossMonthly).toBe(0);
    expect(Number.isNaN(b.netTakeHomeMonthly)).toBe(false);
    expect(ctcFormulaText(b)).toMatch(/^Type the annual CTC/);
  });
  it("Basic % + HRA + allowances above the CTC → warned, gross never silently above CTC", () => {
    const b = ctcTabBreakdown({ ...base, calc: { asOf: NOV, basicPct: 1, isMetro: true } });
    expect(b.overBudget).toBe(true);
    expect(ctcFormulaText(b)).toMatch(/more than this CTC allows/);
    const ok = ctcTabBreakdown(base);
    expect(ok.overBudget).toBe(false);
  });
  it("gross typed by hand after a CTC → the line says so", () => {
    const b = ctcTabBreakdown(base);
    expect(ctcFormulaText(b, 28_000)).toMatch(/Monthly gross ₹28,000 is entered by hand\.$/);
    expect(ctcFormulaText(b, b.grossMonthly)).not.toMatch(/by hand/);
  });
});

describe("R-2700 saved gross is shown as it is until a CTC is typed", () => {
  const saved: CtcTabInput = { ...base, ctcTyped: false, annualCtc: 0, gross: 30_000, basic: null, da: 0, esiApplicable: false };
  it("30,000 saved stays 30,000 (the old tab showed another gross — R-2698 note)", () => {
    const b = ctcTabBreakdown(saved);
    expect(b.source).toBe("saved");
    expect(b.grossMonthly).toBe(30_000);
    // the old path: the saved gross's CTC run back through the CTC-first calculator
    const old = calculateCtcBreakdown(ctcFromEmployee({ monthly_gross: 30_000, basic_monthly: null, da_monthly: 0, pf_applicable: true, esi_applicable: false }, { asOf: NOV }).annualCtc, { asOf: NOV, includeEsi: false });
    expect(old.grossMonthly).not.toBe(30_000);
    expect(ctcFormulaText(b)).toMatch(/^Monthly gross ₹30,000 is the saved salary; CTC/);
  });
  it("excludes policy: saved employee's CTC = gross × 12", () => {
    const b = ctcTabBreakdown({ ...saved, ctcIncludesEmployer: false });
    expect(b.annualCtc).toBe(360_000);
    expect(b.costToCompanyMonthly).toBeGreaterThan(30_000);
  });
  it("round trip: typed CTC → saved gross/Basic → reopened CTC within ₹12 a year", () => {
    for (const annualCtc of [360_000, 240_000, 600_000, 1_000_003]) {
      const typed = ctcTabBreakdown({ ...base, annualCtc });
      const reopened = ctcTabBreakdown({ ...base, ctcTyped: false, gross: typed.grossMonthly, basic: typed.basicMonthly });
      expect(reopened.grossMonthly).toBe(typed.grossMonthly);
      expect(Math.abs(reopened.annualCtc - annualCtc)).toBeLessThanOrEqual(12);
    }
  });
});
