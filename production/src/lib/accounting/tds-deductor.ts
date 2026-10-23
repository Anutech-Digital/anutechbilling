/**
 * TDS we must deduct on a payment (26Q) — does it apply, at what rate, and why.
 *
 * `tds-rates.ts` knows the headline rate per section. This decides whether the section
 * bites at all, which is what the operator actually gets wrong: TDS below the threshold
 * (money withheld for nothing), no TDS after the year's total crossed it (a 40(a)(ia)
 * disallowance and interest), 2% on an individual contractor, 10% on a payee with no PAN.
 *
 * Thresholds as they stand for FY 2026-27 (Finance Act 2025 raised most of them from
 * 1 Apr 2025). Aggregates are per payee per financial year, on the value BEFORE GST:
 *   194C  single payment > ₹30,000 OR year > ₹1,00,000 · 2% (individual / HUF 1%)
 *   194J  year > ₹50,000 · 10% (professional; technical services 2%)
 *   194I  year > ₹6,00,000 · 10% (land / building; plant & machinery 2%)
 *   194H  year > ₹20,000 · 2%
 *   194A  year > ₹10,000 · 10% (interest other than from a bank)
 *   194Q  purchases above ₹50,00,000 in the year · 0.1% on the part above
 * s.206AA: no PAN → the higher of the rate and 20% (194Q: 5%).
 * Once an aggregate limit is crossed, TDS is due on the WHOLE year's payments to that
 * payee — the earlier untaxed ones are reported as `catchUpBase` so the operator can
 * deduct them from this payment or a later one.
 */
import { TDS_SECTION_RATES } from "./tds-rates";
import { rupee } from "@/lib/utils";

export type DeducteeType = "individual" | "huf" | "company" | "firm" | "aop" | "trust" | "other";

/** The PAN's 4th character says who holds it. */
export function deducteeTypeFromPan(pan: string | null | undefined): DeducteeType | null {
  const p = (pan ?? "").trim().toUpperCase();
  if (!isPan(p)) return null;
  switch (p[3]) {
    case "P": return "individual";
    case "H": return "huf";
    case "C": return "company";
    case "F": return "firm";
    case "A": case "B": return "aop";
    case "T": return "trust";
    default:  return "other";
  }
}

export const DEDUCTEE_LABEL: Record<DeducteeType, string> = {
  individual: "individual", huf: "HUF", company: "company", firm: "firm / LLP", aop: "AOP / BOI", trust: "trust", other: "other",
};

export function isPan(s: string | null | undefined): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test((s ?? "").trim().toUpperCase());
}

/** PAN inside a well-formed GSTIN (characters 3–12). */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return null;
  return g.slice(2, 12);
}

export interface TdsThreshold { single: number | null; aggregate: number; onlyAbove: boolean }
export const TDS_THRESHOLDS: Readonly<Record<string, TdsThreshold>> = {
  "194C": { single: 30_000, aggregate: 100_000,   onlyAbove: false },
  "194J": { single: null,   aggregate: 50_000,    onlyAbove: false },
  "194I": { single: null,   aggregate: 600_000,   onlyAbove: false },
  "194H": { single: null,   aggregate: 20_000,    onlyAbove: false },
  "194A": { single: null,   aggregate: 10_000,    onlyAbove: false },
  "194Q": { single: null,   aggregate: 5_000_000, onlyAbove: true  },
};
export const NO_PAN_RATE_PCT = 20;

export interface TdsDecisionInput {
  section: string;
  /** This payment's TDS base (amount less GST). */
  base: number;
  /** Same payee, same FY, before this payment — base of every earlier payment. */
  fyBaseSoFar: number;
  /** Of that, the base on which no TDS was recorded. */
  fyBaseWithoutTds: number;
  pan: string | null | undefined;
}

export interface TdsDecision {
  applies: boolean;
  ratePct: number;
  /** TDS on THIS payment (whole rupees). 0 when it does not apply. */
  tds: number;
  /** Earlier untaxed base this FY that the crossing now catches — deduct on this or a later payment. */
  catchUpBase: number;
  catchUpTds: number;
  noPan: boolean;
  deducteeType: DeducteeType | null;
  /** One line, Hinglish, for the form. */
  reason: string;
  /** How much more this payee can be paid this FY before the section bites (null once crossed / no aggregate). */
  headroom: number | null;
}

/* R-1138: the shared formatter (lakh grouping, sign, rounding) — not a local copy. */
const inr = (n: number) => rupee(n);

export function tdsDecision(i: TdsDecisionInput): TdsDecision {
  const sec = i.section.trim().toUpperCase();
  const rate = TDS_SECTION_RATES[sec];
  const th = TDS_THRESHOLDS[sec];
  const base = Math.max(0, Math.round(i.base || 0));
  const pan = (i.pan ?? "").trim().toUpperCase();
  const noPan = !isPan(pan);
  const deducteeType = deducteeTypeFromPan(pan);
  const none = (reason: string, headroom: number | null = null): TdsDecision =>
    ({ applies: false, ratePct: 0, tds: 0, catchUpBase: 0, catchUpTds: 0, noPan, deducteeType, reason, headroom });
  if (!rate || !th) return none(`${sec}: the app does not know this section's rate — ask your CA and enter the amount yourself.`);

  // Rate: the section's default, the deductee's variant, then s.206AA.
  let ratePct = rate.ratePct;
  if (sec === "194C" && (deducteeType === "individual" || deducteeType === "huf")) ratePct = 1;
  if (noPan) ratePct = sec === "194Q" ? 5 : Math.max(ratePct, NO_PAN_RATE_PCT);

  const yearTotal = i.fyBaseSoFar + base;
  const crossedSingle = th.single !== null && base > th.single;
  const crossedYear = yearTotal > th.aggregate;
  if (!crossedSingle && !crossedYear) {
    const room = th.aggregate - yearTotal;
    return none(
      `${sec}: this year so far ${inr(i.fyBaseSoFar)} + this ${inr(base)} = ${inr(yearTotal)} — within the limit of ${inr(th.aggregate)}` +
      (th.single ? ` (single payment ${inr(th.single)})` : "") + `, TDS not required. ${inr(room)} left.`,
      room,
    );
  }

  // 194Q: only the part above the limit is taxed.
  const taxableNow = th.onlyAbove ? Math.max(0, Math.min(base, yearTotal - th.aggregate)) : base;
  const tds = Math.round((taxableNow * ratePct) / 100);
  const catchUpBase = th.onlyAbove || !crossedYear ? 0 : Math.max(0, Math.round(i.fyBaseWithoutTds));
  const catchUpTds = Math.round((catchUpBase * ratePct) / 100);

  const who = noPan ? "No PAN → s.206AA 20%" : `PAN ${pan}${deducteeType ? ` · ${DEDUCTEE_LABEL[deducteeType]}` : ""}`;
  let reason: string;
  if (th.onlyAbove) {
    reason = `${sec}: purchases this year ${inr(yearTotal)} — ${ratePct}% on the ${inr(taxableNow)} above ${inr(th.aggregate)} (${who}).`;
  } else if (crossedSingle && !crossedYear) {
    reason = `${sec}: single payment ${inr(base)} > ${inr(th.single ?? 0)} → ${ratePct}% (${who}).`;
  } else {
    reason = `${sec}: this year ${inr(i.fyBaseSoFar)} + this ${inr(base)} = ${inr(yearTotal)} > ${inr(th.aggregate)} → ${ratePct}% (${who}).`;
    if (catchUpBase > 0) reason += ` TDS was not deducted on the earlier ${inr(catchUpBase)} — ${inr(catchUpTds)} more must be deducted (from this or the next payment).`;
  }
  return { applies: true, ratePct, tds, catchUpBase, catchUpTds, noPan, deducteeType, reason, headroom: null };
}

/** Statutory dues (TDS / PF / ESI) owed to the government, kind-wise, from the rows that
 *  created them and the challans that paid them. Employer PF/ESI is the company's own
 *  expense but just as much a due; vendor TDS (26Q) is a due the moment it is withheld. */
export interface DuesInput {
  salaries: { tds?: number | null; pf?: number | null; esi?: number | null; pf_employer?: number | null; esi_employer?: number | null }[];
  /** TDS withheld on vendor payments (expenses.tds_amount). */
  vendorTds: number;
  paid: { kind: string; amount?: number | null }[];
}
export interface DuesSummary {
  tdsSalary: number; tdsVendor: number; pf: number; esi: number;
  withheld: number;
  paid: number;
  /** Paid under a specific kind; "mixed" challans are only in `paid`. */
  paidByKind: { tds: number; pf: number; esi: number; mixed: number };
  payable: number;
  /** Kind-wise payable when nothing was paid as "mixed"; null otherwise (can't attribute). */
  payableByKind: { tds: number; pf: number; esi: number } | null;
}
export function statutoryDues(i: DuesInput): DuesSummary {
  const sum = (f: (r: DuesInput["salaries"][number]) => number) => i.salaries.reduce((s, r) => s + f(r), 0);
  const tdsSalary = sum((r) => r.tds ?? 0);
  const pf = sum((r) => (r.pf ?? 0) + (r.pf_employer ?? 0));
  const esi = sum((r) => (r.esi ?? 0) + (r.esi_employer ?? 0));
  const tdsVendor = Math.max(0, Math.round(i.vendorTds || 0));
  const withheld = tdsSalary + tdsVendor + pf + esi;
  const paidByKind = { tds: 0, pf: 0, esi: 0, mixed: 0 };
  for (const p of i.paid) {
    const k = (p.kind === "tds" || p.kind === "pf" || p.kind === "esi") ? p.kind : "mixed";
    paidByKind[k] += p.amount ?? 0;
  }
  const paid = paidByKind.tds + paidByKind.pf + paidByKind.esi + paidByKind.mixed;
  const payable = Math.max(0, withheld - paid);
  const payableByKind = paidByKind.mixed > 0 ? null : {
    tds: Math.max(0, tdsSalary + tdsVendor - paidByKind.tds),
    pf: Math.max(0, pf - paidByKind.pf),
    esi: Math.max(0, esi - paidByKind.esi),
  };
  return { tdsSalary, tdsVendor, pf, esi, withheld, paid, paidByKind, payable, payableByKind };
}
