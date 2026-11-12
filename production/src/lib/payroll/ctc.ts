/**
 * Indian Cost to Company (CTC) Salary Breakdown Calculator Engine.
 * Supports standard Indian Wage Code calculations as well as 100% custom component overrides:
 * - Basic Salary (₹ or %)
 * - HRA Allowance (₹ or %)
 * - Conveyance Allowance (₹)
 * - Medical Allowance (₹)
 * - Special / Flexi Allowance (₹)
 * - Professional Tax (₹)
 * - Employer & Employee PF / ESI / Gratuity toggles
 *
 * PF, ESI and PT come from the shared modules (pf.ts, esi.ts, pt.ts). R-1585: ESI used to be
 * tested here on a partial gross with hard-coded Math.round rates, and the PT slab lived here.
 *
 * The PF caps come from lib/payroll/pf.ts for the month in `opts.asOf` (₹15,000 wage
 * ceiling till Sep 2026, ₹25,000 from Oct 2026) — never a literal ₹1,800 / ₹1,250 here.
 *
 * Two entry points:
 *  • calculateCtcBreakdown(annualCtc) — the "what-if" calculator: CTC in, structure out.
 *  • ctcFromEmployee(employee)        — the employee's REAL structure (monthly gross, Basic, DA,
 *    PF/ESI flags from the employee master) → its CTC. The CTC register and the employee drawer
 *    use this; they used to feed `monthly_gross × 12` to the calculator as if it were the CTC.
 */
import { computePf, pfEpsCap, pfWage, PF_EPS_RATE } from "./pf";
import { computeEsi, ESI_EMPLOYER_RATE } from "./esi";
import { computePt } from "./pt";
import { rupee } from "@/lib/utils";

export interface CtcBreakdown {
  annualCtc: number;
  monthlyCtc: number;

  // Configuration percentages used
  basicPct: number;
  hraPct: number;

  // Earnings (Gross Components)
  basicMonthly: number;
  basicAnnual: number;
  hraMonthly: number;
  hraAnnual: number;
  conveyanceMonthly: number;
  conveyanceAnnual: number;
  medicalMonthly: number;
  medicalAnnual: number;
  specialAllowanceMonthly: number;
  specialAllowanceAnnual: number;
  daMonthly: number; // Dearness Allowance — 0 in the calculator, from the employee master in ctcFromEmployee
  grossMonthly: number;
  grossAnnual: number;

  // Employer Contributions (Included in CTC)
  employerPfMonthly: number; // Total 12% (capped or uncapped)
  employerEpsMonthly: number; // 8.33% (capped at 8.33% of the PF wage ceiling)
  employerEpfShareMonthly: number; // 3.67%
  employerPfAnnual: number;
  employerEsiMonthly: number;
  employerEsiAnnual: number;
  gratuityMonthly: number;
  gratuityAnnual: number;
  totalEmployerContributionMonthly: number;
  totalEmployerContributionAnnual: number;

  // Employee Deductions (Subtracted from Gross)
  employeePfMonthly: number;
  employeePfAnnual: number;
  employeeEsiMonthly: number;
  employeeEsiAnnual: number;
  professionalTaxMonthly: number;
  professionalTaxAnnual: number;
  totalDeductionsMonthly: number;
  totalDeductionsAnnual: number;

  // Final In-Hand / Take Home
  netTakeHomeMonthly: number;
  netTakeHomeAnnual: number;

  /** R-2700: false = the CTC includes the employer's PF / ESI / gratuity (gross = CTC/12 − them);
   *  true = the company policy says the CTC is the gross and those are paid on top. */
  employerOnTop: boolean;
  /** Gross + employer PF + employer ESI + gratuity — what the employee really costs a month. */
  costToCompanyMonthly: number;
  /** CTC/12 that went into neither gross nor the employer parts (rounding; negative = the
   *  typed components cost more than the CTC). 0 when employerOnTop. */
  unallocatedMonthly: number;
  /** Basic + HRA + conveyance + medical alone are more than this CTC allows. */
  overBudget: boolean;
}

/** Gratuity provision — 15 days' wage per year on a 26-day month, per month (≈4.81% of Basic + DA). */
function gratuityOf(basicPlusDaMonthly: number): number {
  return Math.round(basicPlusDaMonthly * (15 / (26 * 12)));
}

/** Monthly figures → the full breakdown with the ×12 annual columns. */
function assemble(m: {
  monthlyCtc: number; basicPct: number; hraPct: number;
  basicMonthly: number; hraMonthly: number; conveyanceMonthly: number; medicalMonthly: number;
  specialAllowanceMonthly: number; daMonthly: number; grossMonthly: number;
  employerPfMonthly: number; employerEpsMonthly: number; employerEsiMonthly: number; gratuityMonthly: number;
  employeePfMonthly: number; employeeEsiMonthly: number; professionalTaxMonthly: number;
}, annualCtc = m.monthlyCtc * 12, extra: { employerOnTop?: boolean; overBudget?: boolean } = {}): CtcBreakdown {
  const totalEmployerContributionMonthly = m.employerPfMonthly + m.employerEsiMonthly + m.gratuityMonthly;
  const employerOnTop = extra.employerOnTop ?? false;
  const costToCompanyMonthly = m.grossMonthly + totalEmployerContributionMonthly;
  const totalDeductionsMonthly = m.employeePfMonthly + m.employeeEsiMonthly + m.professionalTaxMonthly;
  const netTakeHomeMonthly = Math.max(0, m.grossMonthly - totalDeductionsMonthly);
  return {
    annualCtc,
    monthlyCtc: m.monthlyCtc,

    basicPct: m.basicPct,
    hraPct: m.hraPct,

    basicMonthly: m.basicMonthly,
    basicAnnual: m.basicMonthly * 12,
    hraMonthly: m.hraMonthly,
    hraAnnual: m.hraMonthly * 12,
    conveyanceMonthly: m.conveyanceMonthly,
    conveyanceAnnual: m.conveyanceMonthly * 12,
    medicalMonthly: m.medicalMonthly,
    medicalAnnual: m.medicalMonthly * 12,
    specialAllowanceMonthly: m.specialAllowanceMonthly,
    specialAllowanceAnnual: m.specialAllowanceMonthly * 12,
    daMonthly: m.daMonthly,
    grossMonthly: m.grossMonthly,
    grossAnnual: m.grossMonthly * 12,

    employerPfMonthly: m.employerPfMonthly,
    employerEpsMonthly: m.employerEpsMonthly,
    employerEpfShareMonthly: Math.max(0, m.employerPfMonthly - m.employerEpsMonthly),
    employerPfAnnual: m.employerPfMonthly * 12,
    employerEsiMonthly: m.employerEsiMonthly,
    employerEsiAnnual: m.employerEsiMonthly * 12,
    gratuityMonthly: m.gratuityMonthly,
    gratuityAnnual: m.gratuityMonthly * 12,
    totalEmployerContributionMonthly,
    totalEmployerContributionAnnual: totalEmployerContributionMonthly * 12,

    employeePfMonthly: m.employeePfMonthly,
    employeePfAnnual: m.employeePfMonthly * 12,
    employeeEsiMonthly: m.employeeEsiMonthly,
    employeeEsiAnnual: m.employeeEsiMonthly * 12,
    professionalTaxMonthly: m.professionalTaxMonthly,
    professionalTaxAnnual: m.professionalTaxMonthly * 12,
    totalDeductionsMonthly,
    totalDeductionsAnnual: totalDeductionsMonthly * 12,

    netTakeHomeMonthly,
    netTakeHomeAnnual: netTakeHomeMonthly * 12,

    employerOnTop,
    costToCompanyMonthly,
    unallocatedMonthly: employerOnTop ? 0 : m.monthlyCtc - costToCompanyMonthly,
    overBudget: extra.overBudget ?? false,
  };
}

export function calculateCtcBreakdown(
  annualCtcInput: number,
  opts?: {
    isMetro?: boolean;
    basicPct?: number; // Custom basic percentage (e.g., 0.40, 0.50)
    hraPct?: number; // Custom HRA percentage (e.g., 0.40, 0.50)
    customBasicMonthly?: number; // Explicit Basic Salary in ₹
    customHraMonthly?: number; // Explicit HRA in ₹
    customConveyanceMonthly?: number; // Custom conveyance allowance
    customMedicalMonthly?: number; // Custom medical allowance
    customSpecialMonthly?: number; // Explicit Special Allowance in ₹
    customPtMonthly?: number; // Explicit Professional Tax in ₹ (else pt.ts)
    capPfWageCeiling?: boolean; // Cap PF at the statutory wage ceiling for the month
    asOf?: string; // salary month (YYYY-MM) or date — picks the PF ceiling; default today
    includeGratuity?: boolean;
    includeEsi?: boolean;
    /** R-2698: false = the employee is not PF-covered → no PF on either side (default true). */
    includePf?: boolean;
    /** R-2700 company policy: true (default) = the CTC includes employer PF / ESI / gratuity, so
     *  monthly gross = CTC/12 − them; false = monthly gross = CTC/12 and they are on top. */
    ctcIncludesEmployer?: boolean;
  }
): CtcBreakdown {
  const isMetro = opts?.isMetro ?? false;
  const basicPct = opts?.basicPct ?? 0.5; // Default 50%
  const hraPct = opts?.hraPct ?? (isMetro ? 0.5 : 0.4); // Default 40% (non-metro) or 50% (metro)
  const capPfWageCeiling = opts?.capPfWageCeiling ?? true;
  const includeGratuity = opts?.includeGratuity ?? true;
  const includeEsi = opts?.includeEsi ?? true;
  const ctcIncludesEmployer = opts?.ctcIncludesEmployer ?? true;

  const annualCtc = Number.isFinite(annualCtcInput) ? Math.max(0, Math.round(annualCtcInput)) : 0;
  const monthlyCtc = Math.round(annualCtc / 12);

  // 1. Basic Salary (Custom ₹ override or % calculation)
  const basicMonthly = opts?.customBasicMonthly !== undefined && opts.customBasicMonthly > 0
    ? Math.round(opts.customBasicMonthly)
    : Math.round(monthlyCtc * basicPct);

  // 2. HRA (Custom ₹ override or % calculation)
  const hraMonthly = opts?.customHraMonthly !== undefined && opts.customHraMonthly > 0
    ? Math.round(opts.customHraMonthly)
    : Math.round(basicMonthly * hraPct);

  // 3. Conveyance & Medical Allowances
  const conveyanceMonthly = opts?.customConveyanceMonthly !== undefined
    ? Math.max(0, Math.round(opts.customConveyanceMonthly))
    : (monthlyCtc >= 25000 ? 1600 : 0);

  const medicalMonthly = opts?.customMedicalMonthly !== undefined
    ? Math.max(0, Math.round(opts.customMedicalMonthly))
    : (monthlyCtc >= 25000 ? 1250 : 0);

  // 4. PF from pf.ts — 12% each side on Basic, capped at the month's wage ceiling when the
  //    cap applies (computePf); uncapped = 12% of the full Basic.
  //    R-2698: an employee with PF switched off pays / gets none (this used to be charged always).
  const includePf = opts?.includePf ?? true;
  const pf = computePf(basicMonthly, includePf, opts?.asOf, { capped: capPfWageCeiling });
  const employerPfMonthly = pf.employer;
  const employeePfMonthly = pf.employee;
  const employerEpsMonthly = pf.applicable ? Math.min(pfEpsCap(opts?.asOf), Math.round(basicMonthly * PF_EPS_RATE)) : 0;

  // 5. Gratuity (4.81% of Basic = 15/26 / 12)
  const gratuityMonthly = includeGratuity ? gratuityOf(basicMonthly) : 0;

  // 6. Special Allowance + ESI. ESI (esi.ts) is on the FINAL gross — special allowance
  //    included — and its employer share is itself part of the CTC. With no typed special
  //    allowance, take the largest gross whose cost still fits in the monthly CTC.
  //    R-2700: when the policy puts employer costs ON TOP, the whole CTC/12 is the gross.
  const fixedEarnings = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly;
  let specialAllowanceMonthly: number;
  let overBudget = false;
  if (opts?.customSpecialMonthly !== undefined && opts.customSpecialMonthly >= 0) {
    specialAllowanceMonthly = Math.round(opts.customSpecialMonthly);
  } else if (!ctcIncludesEmployer) {
    overBudget = fixedEarnings > monthlyCtc;
    specialAllowanceMonthly = Math.max(0, monthlyCtc - fixedEarnings);
  } else {
    const room = monthlyCtc - employerPfMonthly - gratuityMonthly;
    let gross = room; // no ESI: the whole room is gross
    if (includeEsi && room > 0) {
      // gross + employer ESI(gross) <= room; ESI rounds up, so settle by single steps.
      let g = Math.floor(room / (1 + ESI_EMPLOYER_RATE));
      while (g + 1 + computeEsi(g + 1).employer <= room) g++;
      while (g > 0 && g + computeEsi(g).employer > room) g--;
      if (computeEsi(g).applicable) gross = g; // still within the ESI ceiling with ESI paid
    }
    overBudget = monthlyCtc > 0 && fixedEarnings > gross;
    specialAllowanceMonthly = Math.max(0, gross - fixedEarnings);
  }

  // 7. Gross Monthly Salary = Basic + HRA + Conveyance + Medical + Special Allowance
  const grossMonthly = fixedEarnings + specialAllowanceMonthly;
  const esi = computeEsi(grossMonthly, includeEsi);

  return assemble({
    monthlyCtc, basicPct, hraPct,
    basicMonthly, hraMonthly, conveyanceMonthly, medicalMonthly, specialAllowanceMonthly,
    daMonthly: 0, grossMonthly,
    employerPfMonthly, employerEpsMonthly, employerEsiMonthly: esi.employer, gratuityMonthly,
    // 8. Employee deductions — ESI from esi.ts, PT from pt.ts (a typed PT wins).
    employeePfMonthly, employeeEsiMonthly: esi.employee,
    professionalTaxMonthly: computePt(grossMonthly, { custom: opts?.customPtMonthly }).monthly,
  }, annualCtc, { employerOnTop: !ctcIncludesEmployer, overBudget });
}

/** The employee-master fields a salary structure is made of. */
export interface CtcEmployee {
  monthly_gross: number;
  basic_monthly: number | null;
  da_monthly: number | null;
  pf_applicable: boolean;
  esi_applicable: boolean;
  /** R-2698: true = PF on the full Basic + DA (above the ceiling); missing/false = capped. */
  pf_full_wage?: boolean | null;
}

export interface EmployeeCtc extends CtcBreakdown {
  /** true when the employee has no Basic set — PF and gratuity then use the whole gross,
   *  exactly as payroll does (pf.ts pfWage). */
  basicAssumed: boolean;
}

/**
 * The employee's actual CTC: their monthly gross is the gross (never reverse-engineered from a
 * CTC), and the company's cost on top of it — employer PF on Basic + DA (pf.ts, the salary
 * month's ceiling), employer ESI on the gross when the employee is ESI-covered (esi.ts) and the
 * gratuity provision on Basic + DA. Employee PF/ESI and PT (pt.ts) give the take-home.
 * The employee master has no HRA/conveyance/medical split, so everything above Basic + DA is
 * reported as one "other allowances" figure (specialAllowanceMonthly).
 */
export function ctcFromEmployee(
  e: CtcEmployee,
  opts?: {
    asOf?: string; includeGratuity?: boolean; ptMonthly?: number | null; ptState?: string | null;
    /** R-2700 company policy: false = the CTC is the gross (employer costs on top). Default true. */
    ctcIncludesEmployer?: boolean;
  },
): EmployeeCtc {
  const grossMonthly = Math.max(0, Math.round(e.monthly_gross || 0));
  const wage = pfWage({ gross: grossMonthly, basic: e.basic_monthly, da: e.da_monthly });
  const basicAssumed = wage.assumed;
  const daMonthly = basicAssumed ? 0 : Math.min(grossMonthly, Math.max(0, Math.round(e.da_monthly ?? 0)));
  const basicMonthly = basicAssumed ? grossMonthly : Math.min(grossMonthly - daMonthly, Math.max(0, Math.round(e.basic_monthly ?? 0)));

  const pf = computePf(wage.base, e.pf_applicable, opts?.asOf, { capped: !e.pf_full_wage });
  const esi = computeEsi(grossMonthly, e.esi_applicable);
  const gratuityMonthly = (opts?.includeGratuity ?? true) ? gratuityOf(basicMonthly + daMonthly) : 0;
  const employerEpsMonthly = pf.applicable ? Math.min(pfEpsCap(opts?.asOf), Math.round(pf.base * PF_EPS_RATE)) : 0;

  const onTop = opts?.ctcIncludesEmployer === false;
  const monthlyCtc = onTop ? grossMonthly : grossMonthly + pf.employer + esi.employer + gratuityMonthly;
  const r = assemble({
    monthlyCtc,
    basicPct: grossMonthly > 0 ? basicMonthly / grossMonthly : 0,
    hraPct: 0,
    basicMonthly, hraMonthly: 0, conveyanceMonthly: 0, medicalMonthly: 0,
    specialAllowanceMonthly: Math.max(0, grossMonthly - basicMonthly - daMonthly),
    daMonthly, grossMonthly,
    employerPfMonthly: pf.employer, employerEpsMonthly, employerEsiMonthly: esi.employer, gratuityMonthly,
    employeePfMonthly: pf.employee, employeeEsiMonthly: esi.employee,
    professionalTaxMonthly: computePt(grossMonthly, { custom: opts?.ptMonthly, state: opts?.ptState }).monthly,
  }, monthlyCtc * 12, { employerOnTop: onTop });
  return { ...r, basicAssumed };
}

/** What the employee form's "CTC & Salary Breakdown" tab is showing. */
export interface CtcTabInput {
  /** true once the user typed an Annual CTC in this dialog. */
  ctcTyped: boolean;
  annualCtc: number;
  /** The form's Monthly Gross / Basic / DA (Basic null = not set). */
  gross: number;
  basic: number | null;
  da: number;
  pfApplicable: boolean;
  esiApplicable: boolean;
  pfFullWage: boolean;
  includeGratuity: boolean;
  /** Company payroll policy (lib/payroll/policy.ts). */
  ctcIncludesEmployer: boolean;
  /** The calculator's component choices (Basic %, HRA, allowances, PT). */
  calc?: Pick<NonNullable<Parameters<typeof calculateCtcBreakdown>[1]>,
    "isMetro" | "basicPct" | "customBasicMonthly" | "customHraMonthly" | "customConveyanceMonthly"
    | "customMedicalMonthly" | "customSpecialMonthly" | "customPtMonthly" | "asOf">;
}

export type CtcTabBreakdown = CtcBreakdown & {
  /** "saved" = the employee's own gross (nothing typed); "ctc" = worked out from the typed CTC. */
  source: "saved" | "ctc";
};

/**
 * R-2700: ONE rule for the tab. Until a CTC is typed, an employee with a gross shows THEIR
 * gross (ctcFromEmployee) — the old tab ran that gross's CTC back through the CTC-first
 * calculator with a different Basic split and showed another gross (30,000 → 31,347, R-2698).
 * A typed CTC is split by the calculator under the company policy, and that gross is what
 * the form fills into Monthly Gross Salary.
 */
export function ctcTabBreakdown(i: CtcTabInput): CtcTabBreakdown {
  const gross = Math.max(0, Math.round(Number.isFinite(i.gross) ? i.gross : 0));
  if (!i.ctcTyped && gross > 0) {
    return {
      ...ctcFromEmployee(
        { monthly_gross: gross, basic_monthly: i.basic, da_monthly: i.da, pf_applicable: i.pfApplicable, esi_applicable: i.esiApplicable, pf_full_wage: i.pfFullWage },
        { asOf: i.calc?.asOf, includeGratuity: i.includeGratuity, ctcIncludesEmployer: i.ctcIncludesEmployer, ptMonthly: i.calc?.customPtMonthly },
      ),
      source: "saved",
    };
  }
  return {
    ...calculateCtcBreakdown(i.ctcTyped ? i.annualCtc : 0, {
      ...i.calc,
      capPfWageCeiling: !i.pfFullWage,
      includePf: i.pfApplicable,
      includeEsi: i.esiApplicable,
      includeGratuity: i.includeGratuity,
      ctcIncludesEmployer: i.ctcIncludesEmployer,
    }),
    source: "ctc",
  };
}

/**
 * The one line under the CTC field that says how the Monthly Gross was reached.
 * `grossInForm` = what the Monthly Gross box holds now (differs = typed by hand).
 */
export function ctcFormulaText(b: CtcTabBreakdown, grossInForm?: number): string {
  if (b.annualCtc <= 0) return "Type the annual CTC — the monthly gross and its breakdown fill in from it.";
  const employerParts = [
    b.employerPfMonthly > 0 ? `employer PF ${rupee(b.employerPfMonthly)}` : null,
    b.employerEsiMonthly > 0 ? `employer ESI ${rupee(b.employerEsiMonthly)}` : null,
    b.gratuityMonthly > 0 ? `gratuity ${rupee(b.gratuityMonthly)}` : null,
  ].filter((x): x is string => x !== null);
  let line: string;
  if (b.source === "saved") {
    line = b.employerOnTop
      ? `Monthly gross ${rupee(b.grossMonthly)} is the saved salary; CTC = gross × 12.`
      : `Monthly gross ${rupee(b.grossMonthly)} is the saved salary; CTC ${rupee(b.annualCtc)} = (gross${employerParts.map((p) => ` + ${p}`).join("")}) × 12.`;
    if (b.employerOnTop && employerParts.length) line += ` On top: ${employerParts.join(" + ")} (cost ${rupee(b.costToCompanyMonthly)}/mo).`;
    line += " Type a CTC to work the gross out from it.";
  } else if (b.employerOnTop) {
    line = `Monthly gross ${rupee(b.grossMonthly)} = CTC ${rupee(b.annualCtc)} ÷ 12.`;
    if (employerParts.length) line += ` On top: ${employerParts.join(" + ")} (cost ${rupee(b.costToCompanyMonthly)}/mo).`;
  } else {
    line = `Monthly gross ${rupee(b.grossMonthly)} = CTC ${rupee(b.annualCtc)} ÷ 12 (${rupee(b.monthlyCtc)})${employerParts.map((p) => ` − ${p}`).join("")}`;
    line += b.unallocatedMonthly > 0 ? ` − ${rupee(b.unallocatedMonthly)} rounding.` : ".";
  }
  if (b.overBudget) {
    line += ` Basic + HRA + allowances (${rupee(b.basicMonthly + b.hraMonthly + b.conveyanceMonthly + b.medicalMonthly)}) are more than this CTC allows — lower the Basic % or the allowances.`;
  } else if (b.source === "ctc" && !b.employerOnTop && b.unallocatedMonthly < 0) {
    line += ` The typed components cost ${rupee(-b.unallocatedMonthly)}/mo more than the CTC.`;
  }
  if (grossInForm !== undefined && b.source === "ctc" && Math.round(grossInForm) !== b.grossMonthly) {
    line += ` Monthly gross ${rupee(Math.round(grossInForm))} is entered by hand.`;
  }
  return line;
}
