/**
 * EPFO ECR (Electronic Challan-cum-Return) — the text file the unified portal
 * imports for a month's PF, one line per member.
 *
 * Format (ECR 2.0, ".txt", fields joined by "#~#", no header):
 *   UAN #~# Member name #~# Gross wages #~# EPF wages #~# EPS wages #~# EDLI wages
 *   #~# EPF contribution (EE) #~# EPS contribution (ER) #~# EPF-EPS diff (ER)
 *   #~# NCP days #~# Refund of advances
 *
 * Wages: EPF wages are the PF wage the payslip was computed on (Basic + DA, prorated);
 * EPS and EDLI wages are that, capped at the ceiling for the month (lib/payroll/pf.ts).
 * Contributions: EE = employee PF as deducted; EPS = 8.33% of EPS wages; the employer's
 * remaining share (employer PF − EPS) goes in the diff column. NCP = loss-of-pay days.
 * Admin (0.5%) and EDLI (0.5%) charges are computed by the portal from the totals.
 *
 * A member with no UAN cannot be uploaded: the row is left out and named in `skipped`
 * so nobody files a short return without knowing.
 */
import { pfWageCeiling, PF_EPS_RATE } from "./pf";

export interface EcrInput {
  period: string;                 // YYYY-MM
  employee: string;
  uan: string | null;
  gross: number;                  // gross for the month (before LOP)
  lopAmount?: number | null;
  lopDays?: number | null;
  /** PF wage stored on the payslip; null on payslips from before 20260927180000. */
  pfWage: number | null;
  employeePf: number;
  employerPf: number;
}

export interface EcrLine {
  uan: string; name: string; gross: number; epfWages: number; epsWages: number; edliWages: number;
  ee: number; eps: number; erDiff: number; ncpDays: number; refund: number;
  /** PF wage was not on the payslip — earned gross used instead. */
  wageAssumed: boolean;
}

export interface EcrFile {
  lines: EcrLine[];
  text: string;
  skipped: { employee: string; reason: string }[];
  totals: { epfWages: number; ee: number; eps: number; erDiff: number };
}

export function ecrLine(i: EcrInput): EcrLine | { skipped: string } {
  const uan = (i.uan ?? "").replace(/\s+/g, "");
  if (!/^\d{12}$/.test(uan)) return { skipped: uan ? `UAN "${uan}" is not 12 digits` : "No UAN (Employee → Statutory → PF number)" };
  const ceiling = pfWageCeiling(i.period);
  const earned = Math.max(0, Math.round(i.gross || 0) - Math.round(i.lopAmount ?? 0));
  const wageAssumed = i.pfWage === null || i.pfWage === undefined;
  const epfWages = wageAssumed ? earned : Math.max(0, Math.round(i.pfWage as number));
  const epsWages = Math.min(epfWages, ceiling);
  const eps = i.employerPf > 0 ? Math.round(epsWages * PF_EPS_RATE) : 0;
  const erDiff = Math.max(0, Math.round(i.employerPf) - eps);
  return {
    uan, name: i.employee.trim(), gross: Math.round(i.gross || 0), epfWages, epsWages, edliWages: epsWages,
    ee: Math.round(i.employeePf), eps, erDiff, ncpDays: Math.round(Number(i.lopDays ?? 0)), refund: 0, wageAssumed,
  };
}

export function buildEcr(rows: EcrInput[]): EcrFile {
  const lines: EcrLine[] = [];
  const skipped: EcrFile["skipped"] = [];
  for (const r of rows) {
    if (!(r.employeePf > 0 || r.employerPf > 0)) continue;   // not a PF member this month
    const l = ecrLine(r);
    if ("skipped" in l) skipped.push({ employee: r.employee, reason: l.skipped });
    else lines.push(l);
  }
  const text = lines
    .map((l) => [l.uan, l.name, l.gross, l.epfWages, l.epsWages, l.edliWages, l.ee, l.eps, l.erDiff, l.ncpDays, l.refund].join("#~#"))
    .join("\r\n");
  const totals = lines.reduce((t, l) => ({ epfWages: t.epfWages + l.epfWages, ee: t.ee + l.ee, eps: t.eps + l.eps, erDiff: t.erDiff + l.erDiff }),
    { epfWages: 0, ee: 0, eps: 0, erDiff: 0 });
  return { lines, text, skipped, totals };
}
