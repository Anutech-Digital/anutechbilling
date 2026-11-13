/**
 * R-2733 (Hitesh, 13 Nov 2026) — ONE source for "what the employee takes home".
 *
 * `salaryAutoDeductions` is the PF / ESI / TDS the Pay salary dialog fills by itself (the dialog
 * calls it — it used to work them out inline). `monthNetPay` runs it for a FULL month of the
 * salary in force with nothing else typed (no LOP, bonus, arrears, advance or Other), which is
 * the net the Pay salary dialog shows for that month when nothing is changed. The Employees
 * table's "In-hand / month" and the CTC tab's "Monthly Net Pay" both read it, so neither can
 * disagree with what Pay salary books.
 *
 * Professional Tax is NOT in it: the owner's rule (13 Nov 2026) is that PT does not apply, and Pay
 * salary deducts none. The CTC register and the employee drawer read this same net.
 */
import { computePf, pfWage, type PfContribution, type PfWage } from "./pf";
import { computeEsi, esiStickyCovered, type EsiContribution } from "./esi";
import { estimateMonthlyTds, fyStartOfPeriod, type TdsEstimate } from "./income-tax";
import { salaryInForce, type SalaryRevision, type SalaryStructure } from "./salary-revision";
import { rupee } from "@/lib/utils";

/** The payslip fields the auto deductions read (salary_payments rows of this employee). */
export interface PayslipFacts {
  period: string;
  gross: number;
  lop_amount?: number | null;
  incentive?: number | null;
  tds?: number | null;
  esi?: number | null;
}

export interface SalaryAutoInput {
  /** Salary month, YYYY-MM. */
  period: string;
  /** "Salary to pay" — the full month or a prorated part. */
  gross: number;
  lopAmount?: number;
  /** Bonus / incentive + revision arrears paid with this salary (TDS counts them, PF / ESI do not). */
  extraEarned?: number;
  /** The full month's gross in force (PF prorates Basic + DA by gross ÷ this). */
  monthGross: number;
  /** Basic / DA in force for the month (Basic null = not set → PF on the whole gross). */
  basic: number | null;
  da: number | null;
  pfApplicable: boolean;
  pfFullWage: boolean;
  esiApplicable: boolean;
  /** Expected gross for each later month of the FY (the employee's current monthly gross). */
  monthlyGrossAhead: number;
  /** This employee's payslips (any order; other FYs / later months are ignored). */
  history: readonly PayslipFacts[];
}

export interface SalaryAuto {
  earned: number;
  pfWage: PfWage;
  pf: PfContribution;
  esiSticky: boolean;
  esi: EsiContribution;
  tds: TdsEstimate;
}

const whole = (n: number | null | undefined) => Math.max(0, Math.round(Number(n) || 0));

/** The PF / ESI / TDS Pay salary fills for a month (employee shares deducted, employer shares on top). */
export function salaryAutoDeductions(i: SalaryAutoInput): SalaryAuto {
  const gross = whole(i.gross);
  const lop = whole(i.lopAmount);
  const earned = Math.max(0, gross - lop) + whole(i.extraEarned);
  /* ESI on the month's wage (gross − LOP, bonus excluded); covered earlier in the contribution
     period → stays covered above ₹21,000 (esi.ts). */
  const esiSticky = esiStickyCovered(i.period, [...i.history]);
  const esi = computeEsi(Math.max(0, gross - lop), i.esiApplicable, esiSticky);
  /* PF on Basic + DA in force (prorated like the gross), capped at the month's ceiling unless the
     employee's PF basis is the full wage (pf.ts). */
  const wage = pfWage({ gross, lopAmount: lop, basic: i.basic, da: i.da, monthlyGross: i.monthGross });
  const pf = computePf(wage.base, i.pfApplicable, i.period, { capped: !i.pfFullWage });
  /* s.192: the year's projected tax less TDS already deducted this FY, over the months left. */
  const tds = estimateMonthlyTds({
    period: i.period,
    thisMonthEarned: earned,
    earlier: i.history.map((p) => ({ period: p.period, earned: Math.max(0, p.gross - (p.lop_amount ?? 0)) + (p.incentive ?? 0), tds: p.tds ?? 0 })),
    monthlyGrossAhead: i.monthlyGrossAhead,
  });
  return { earned, pfWage: wage, pf, esiSticky, esi, tds };
}

export interface NetPayEmployee extends SalaryStructure {
  pf_applicable: boolean;
  esi_applicable: boolean;
  pf_full_wage?: boolean | null;
}

export interface MonthNetPay {
  period: string;
  gross: number;
  pf: number;
  esi: number;
  tds: number;
  /** gross − employee PF − employee ESI − TDS. */
  net: number;
  /** One line: how the net is made, and what is not in it. */
  explain: string;
}

/**
 * The net Pay salary shows for a full `period` of the salary in force, nothing else typed.
 * null = nothing to show (no salary set) — never a made-up figure.
 */
export function monthNetPay(
  employee: NetPayEmployee,
  revisions: readonly SalaryRevision[],
  period: string,
  history: readonly PayslipFacts[],
): MonthNetPay | null {
  const inForce = salaryInForce(employee, revisions, period);
  const gross = whole(inForce.monthly_gross);
  if (gross <= 0) return null;
  const a = salaryAutoDeductions({
    period, gross, monthGross: gross,
    basic: inForce.basic_monthly, da: inForce.da_monthly,
    pfApplicable: employee.pf_applicable, pfFullWage: Boolean(employee.pf_full_wage), esiApplicable: employee.esi_applicable,
    monthlyGrossAhead: whole(employee.monthly_gross),
    history,
  });
  const pf = a.pf.employee, esi = a.esi.employee, tds = a.tds.thisMonth;
  const net = Math.max(0, gross - pf - esi - tds);
  const inr = rupee; // R-1138: rupee() formats every amount
  const parts = [pf > 0 ? `PF ${inr(pf)}` : null, esi > 0 ? `ESI ${inr(esi)}` : null, tds > 0 ? `TDS ${inr(tds)}` : null].filter(Boolean);
  const explain = `Full month: ${inr(net)} = gross ${inr(gross)}${parts.length ? " − " + parts.join(" − ") : ""}, as Pay salary works it out for a full month (LOP / advances / bonus change it).`;
  return { period, gross, pf, esi, tds, net, explain };
}

/** The payslips of one FY grouped by employee — one query for the whole table, looked up per row. */
export function payslipsByEmployee<T extends PayslipFacts & { employee_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.employee_id);
    if (list) list.push(r); else out.set(r.employee_id, [r]);
  }
  return out;
}

/** First month (YYYY-04) of the Indian FY that `period` falls in — TDS and ESI periods sit inside it. */
export function fyFirstPeriod(period: string): string {
  return `${fyStartOfPeriod(period)}-04`; // the same FY rule estimateMonthlyTds uses
}

/**
 * R-2733 (a): Monthly and Annual CTC are ONE figure — the form keeps the annual one; a monthly
 * typed in is ×12 (₹25,000 → ₹3,00,000). Blank / not a number → "" (no CTC).
 */
export function annualFromMonthlyCtc(monthlyText: string): string {
  const t = monthlyText.trim();
  if (t === "") return "";
  const m = Number(t);
  if (!Number.isFinite(m) || m <= 0) return "";
  return String(Math.round(m * 12));
}

/** What the Monthly CTC box shows for an annual CTC (rounded to the rupee). */
export function monthlyFromAnnualCtc(annualText: string): string {
  const t = annualText.trim();
  if (t === "") return "";
  const a = Number(t);
  if (!Number.isFinite(a) || a <= 0) return "";
  return String(Math.round(a / 12));
}

/**
 * R-2733 (R-2727 item 4): the "(…)" after "Basic Salary" on the CTC tab. A Basic the CTC cannot
 * carry (overBudget, or a share above 100% of CTC ÷ 12) is not a percentage — Custom Basic 20,000
 * on CTC 1,20,000 showed "Basic Salary (200%)". It says the same as the disabled Apply reason.
 */
export function basicShareText(b: { basicPct: number; overBudget: boolean }): string {
  if (b.overBudget || !Number.isFinite(b.basicPct) || b.basicPct > 1) return "more than this CTC allows";
  return `${Math.round(Math.max(0, b.basicPct) * 100)}%`;
}

/**
 * R-2733 (b): with no CTC typed the gross is the employee's own — a Basic % is then that share
 * of the monthly gross, and it is written into the form's Basic (what Save stores), never more
 * than gross − DA. null = nothing to set (no gross).
 */
export function basicFromPct(pct: number, gross: number, da: number): number | null {
  const g = whole(gross);
  if (g <= 0 || !Number.isFinite(pct) || pct <= 0) return null;
  return Math.min(Math.max(0, g - whole(da)), Math.round(g * Math.min(pct, 1)));
}
