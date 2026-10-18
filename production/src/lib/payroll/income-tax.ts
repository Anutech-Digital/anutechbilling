/**
 * Income tax on salary (s.192) — the deductor's side: what to withhold each month, and
 * the year-end working behind Form 16 Part B / 24Q Annexure II.
 *
 * NEW REGIME ONLY (s.115BAC), which is the default since FY 2023-24 and the only one
 * this business's employees are on. Slabs are a dated table like the PF ceiling — one
 * row per Finance Act — so a March payslip and an April payslip each use their own year.
 *
 *   FY 2025-26 onward (Finance Act 2025):  0–4L nil · 4–8L 5% · 8–12L 10% · 12–16L 15%
 *   · 16–20L 20% · 20–24L 25% · above 30%; standard deduction ₹75,000; rebate s.87A wipes
 *   the tax when taxable income ≤ ₹12,00,000 (with marginal relief just above it);
 *   health & education cess 4%.
 *
 * Employee-side deductions (80C etc.) do not apply in the new regime; employer NPS
 * (80CCD(2)) would, and is not modelled — the working says "salary as paid".
 */

import { fyStartYear, fyLabelOfYear } from "@/lib/dates/ist";

export interface Slab { upto: number | null; ratePct: number }
export interface TaxYear { fyStart: number; slabs: Slab[]; standardDeduction: number; rebateLimit: number; cessPct: number }

export const TAX_YEARS: readonly TaxYear[] = [
  {
    fyStart: 2025,
    slabs: [
      { upto: 400_000, ratePct: 0 }, { upto: 800_000, ratePct: 5 }, { upto: 1_200_000, ratePct: 10 },
      { upto: 1_600_000, ratePct: 15 }, { upto: 2_000_000, ratePct: 20 }, { upto: 2_400_000, ratePct: 25 },
      { upto: null, ratePct: 30 },
    ],
    standardDeduction: 75_000, rebateLimit: 1_200_000, cessPct: 4,
  },
];

/** Indian FY start year for a YYYY-MM period. */
export function fyStartOfPeriod(period: string): number {
  return fyStartYear(period.slice(0, 7));
}
export function fyLabelOf(fyStart: number): string {
  return fyLabelOfYear(fyStart);
}
export function fyPeriods(fyStart: number): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const y = m >= 4 ? fyStart : fyStart + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
  });
}

export function taxYearFor(fyStart: number): TaxYear {
  let ty = TAX_YEARS[0];
  for (const t of TAX_YEARS) if (t.fyStart <= fyStart) ty = t;
  return ty;
}

export interface TaxComputation {
  grossSalary: number;
  standardDeduction: number;
  taxableIncome: number;
  taxOnSlabs: number;
  rebate87A: number;
  taxAfterRebate: number;
  cess: number;
  totalTax: number;
}

/** Tax for the year on a gross salary (new regime). Whole rupees. */
export function computeAnnualTax(grossSalary: number, fyStart: number): TaxComputation {
  const ty = taxYearFor(fyStart);
  const gross = Math.max(0, Math.round(grossSalary || 0));
  const standardDeduction = Math.min(gross, ty.standardDeduction);
  const taxable = gross - standardDeduction;
  let tax = 0, lower = 0;
  for (const s of ty.slabs) {
    const upper = s.upto ?? Infinity;
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * (s.ratePct / 100);
    lower = upper;
  }
  tax = Math.round(tax);
  /* s.87A: nothing to pay up to the rebate limit; just above it the tax can never exceed
     the income over the limit (marginal relief). */
  let rebate = 0;
  if (taxable <= ty.rebateLimit) rebate = tax;
  else rebate = Math.max(0, tax - (taxable - ty.rebateLimit));
  const afterRebate = tax - rebate;
  const cess = Math.round((afterRebate * ty.cessPct) / 100);
  return { grossSalary: gross, standardDeduction, taxableIncome: taxable, taxOnSlabs: tax, rebate87A: rebate, taxAfterRebate: afterRebate, cess, totalTax: afterRebate + cess };
}

export interface TdsEstimateInput {
  period: string;                 // the month being paid
  thisMonthEarned: number;        // gross − LOP + incentive for this month
  /** Earlier payslips of the same FY: earned (gross − lop + incentive) and TDS. */
  earlier: { period: string; earned: number; tds: number }[];
  /** Expected gross for each remaining month after this one (usually monthly_gross). */
  monthlyGrossAhead: number;
}
export interface TdsEstimate {
  fyStart: number;
  monthsAhead: number;            // months left in the FY after this one
  projectedAnnual: number;
  tax: TaxComputation;
  tdsSoFar: number;
  balanceTax: number;             // year's tax − TDS already deducted
  thisMonth: number;              // balance ÷ (months ahead + 1), whole rupees, never < 0
  note: string;
}

/** s.192: spread the year's projected tax over the months left, less what was already
 *  deducted — the standard employer method. */
export function estimateMonthlyTds(i: TdsEstimateInput): TdsEstimate {
  const fyStart = fyStartOfPeriod(i.period);
  const periods = fyPeriods(fyStart);
  const idx = periods.indexOf(i.period.slice(0, 7));
  const monthsAhead = idx < 0 ? 0 : 11 - idx;
  const sameFy = i.earlier.filter((e) => fyStartOfPeriod(e.period) === fyStart && e.period < i.period.slice(0, 7));
  const earnedSoFar = sameFy.reduce((s, e) => s + Math.max(0, e.earned), 0);
  const tdsSoFar = sameFy.reduce((s, e) => s + Math.max(0, e.tds), 0);
  const projectedAnnual = earnedSoFar + Math.max(0, Math.round(i.thisMonthEarned)) + monthsAhead * Math.max(0, Math.round(i.monthlyGrossAhead));
  const tax = computeAnnualTax(projectedAnnual, fyStart);
  const balanceTax = tax.totalTax - tdsSoFar;
  const thisMonth = Math.max(0, Math.round(balanceTax / (monthsAhead + 1)));
  const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
  const note = tax.totalTax === 0
    ? `FY ${fyLabelOf(fyStart)}: saal ka andaaza ${inr(projectedAnnual)} — taxable ${inr(tax.taxableIncome)} ≤ ${inr(taxYearFor(fyStart).rebateLimit)}, s.87A se tax shunya. TDS nahi.`
    : `FY ${fyLabelOf(fyStart)}: saal ka andaaza ${inr(projectedAnnual)} → tax ${inr(tax.totalTax)} (cess samet) − ab tak kata ${inr(tdsSoFar)} = ${inr(Math.max(0, balanceTax))}, ${monthsAhead + 1} mahine mein → ${inr(thisMonth)}/mahina.`;
  return { fyStart, monthsAhead, projectedAnnual, tax, tdsSoFar, balanceTax, thisMonth, note };
}

export interface Form16Row { period: string; payDate: string | null; gross: number; lopAmount: number; incentive: number; earned: number; pf: number; esi: number; tds: number }
export interface Form16Working {
  fyStart: number; fyLabel: string;
  rows: Form16Row[];
  monthsPaid: number;
  tax: TaxComputation;
  tdsDeducted: number;
  /** tax − TDS: positive = short deducted (deduct before March), negative = excess (refund via ITR). */
  balance: number;
  employeePf: number;
}

/** Year-end working per employee: Form 16 Part B figures + 24Q Annexure II inputs. */
export function form16Working(
  payslips: { period: string; pay_date?: string | null; gross: number; lop_amount?: number | null; incentive?: number | null; pf?: number | null; esi?: number | null; tds?: number | null }[],
  fyStart: number,
): Form16Working {
  const rows: Form16Row[] = payslips
    .filter((p) => fyStartOfPeriod(p.period) === fyStart)
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((p) => {
      const lop = Math.max(0, p.lop_amount ?? 0), inc = Math.max(0, p.incentive ?? 0);
      return { period: p.period, payDate: p.pay_date ?? null, gross: p.gross, lopAmount: lop, incentive: inc, earned: Math.max(0, p.gross - lop) + inc, pf: p.pf ?? 0, esi: p.esi ?? 0, tds: p.tds ?? 0 };
    });
  const grossSalary = rows.reduce((s, r) => s + r.earned, 0);
  const tax = computeAnnualTax(grossSalary, fyStart);
  const tdsDeducted = rows.reduce((s, r) => s + r.tds, 0);
  return { fyStart, fyLabel: fyLabelOf(fyStart), rows, monthsPaid: rows.length, tax, tdsDeducted, balance: tax.totalTax - tdsDeducted, employeePf: rows.reduce((s, r) => s + r.pf, 0) };
}
