/**
 * R-1864 — EMI / loan amortisation schedule (reducing balance), whole rupees.
 *
 * An asset bought on EMI is repaid in instalments. Each EMI = principal + interest:
 * the interest is the month's rate on the balance still owed (a P&L finance cost), the
 * principal reduces the loan (Balance Sheet). The whole EMI is never an expense.
 *
 *  - EMI (when not given): P·r·(1+r)^n / ((1+r)^n − 1), r = annual % / 12 / 100, rounded to
 *    the rupee. Rate 0 ("no-cost EMI"): P / n rounded, no interest at all.
 *  - Each row: interest = round(balance · r); principal = EMI − interest.
 *  - The LAST row absorbs every rupee of rounding: its principal is the balance left, so the
 *    principal column always sums to the loan and the balance ends at exactly 0.
 *  - A lender's EMI (from the loan letter) may be passed in; it is used as given.
 *
 * The database re-checks every schedule it is sent (record_emi_asset_purchase,
 * reconcile_bank_debit_to_emi, prepay_emi_loan — migration r1864): sums, chain, last balance 0.
 */

import { rupee } from "@/lib/utils";

export type ScheduleRow = {
  seq: number;
  dueOn: string;          // YYYY-MM-DD
  emi: number;            // principal + interest, ₹
  principal: number;
  interest: number;
  balanceAfter: number;   // loan left after this instalment
};

export type ScheduleInput = {
  principal: number;      // ₹ owed
  annualRatePct: number;  // 0 = no-cost EMI
  months: number;         // instalments
  firstDueOn: string;     // YYYY-MM-DD
  emi?: number | null;    // lender's EMI; computed when absent
  startSeq?: number;      // numbering continues after a prepayment
};

const monthlyRate = (annualRatePct: number) => Math.max(0, annualRatePct) / 12 / 100;

/** The standard EMI, rounded to the rupee. */
export function emiFor(principal: number, annualRatePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return Math.round(principal / months);
  const f = Math.pow(1 + r, months);
  return Math.round((principal * r * f) / (f - 1));
}

/** Same day of the month, `k` months on; clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonthsIso(iso: string, k: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const idx = (m - 1) + k;
  const yy = y + Math.floor(idx / 12);
  const mm = ((idx % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function buildSchedule(input: ScheduleInput): ScheduleRow[] {
  const P = Math.round(input.principal);
  const n = Math.round(input.months);
  if (!(P > 0) || !(n > 0) || !input.firstDueOn) return [];
  const r = monthlyRate(input.annualRatePct);
  const emi = input.emi && input.emi > 0 ? Math.round(input.emi) : emiFor(P, input.annualRatePct, n);
  const start = input.startSeq ?? 1;
  const rows: ScheduleRow[] = [];
  let bal = P;
  for (let i = 0; i < n && bal > 0; i++) {
    const interest = Math.round(bal * r);
    if (i < n - 1 && emi < interest) {
      throw new Error(`The EMI ${rupee(emi)} does not cover the month's interest ${rupee(interest)} — check the rate or the EMI`);
    }
    // The last row takes whatever is left; a lender's larger EMI can also clear the loan early.
    const principal = i === n - 1 ? bal : Math.min(bal, emi - interest);
    bal -= principal;
    rows.push({ seq: start + i, dueOn: addMonthsIso(input.firstDueOn, i), emi: principal + interest, principal, interest, balanceAfter: bal });
  }
  return rows;
}

export type Recompute = "reduce_tenure" | "reduce_emi";

/**
 * The rest of the loan after a prepayment / a payment that was not the scheduled EMI.
 *  - reduce_emi:    same number of instalments left, a new (smaller) EMI.
 *  - reduce_tenure: the same EMI, so the loan ends sooner (fewer rows).
 */
export function recomputeRemaining(opts: {
  outstanding: number; annualRatePct: number; nextSeq: number; nextDueOn: string;
  remainingMonths: number; currentEmi: number; mode: Recompute;
}): ScheduleRow[] {
  if (opts.outstanding <= 0 || opts.remainingMonths <= 0) return [];
  return buildSchedule({
    principal: opts.outstanding,
    annualRatePct: opts.annualRatePct,
    months: opts.remainingMonths,
    firstDueOn: opts.nextDueOn,
    startSeq: opts.nextSeq,
    emi: opts.mode === "reduce_tenure" ? opts.currentEmi : null,
  });
}

export const scheduleTotals = (rows: ScheduleRow[]) => ({
  emi: rows.reduce((s, r) => s + r.emi, 0),
  principal: rows.reduce((s, r) => s + r.principal, 0),
  interest: rows.reduce((s, r) => s + r.interest, 0),
});

/** The shape the database functions take. */
export const toRpcRows = (rows: ScheduleRow[]) => rows.map((r) => ({
  seq: r.seq, due_on: r.dueOn, emi: r.emi, principal: r.principal, interest: r.interest, balance_after: r.balanceAfter,
}));

/**
 * Splitting a bank debit against the instalment it pays.
 *  - same as the EMI → the schedule's principal + interest;
 *  - more → the extra is a late fee / bounce charge (an expense) or extra principal (part
 *    prepayment — the rest of the schedule is recomputed);
 *  - less → interest first, the rest reduces the loan; the rest of the schedule is recomputed.
 */
export type ExtraAs = "late_fee" | "prepay";
export function splitDebit(row: { emi: number; principal: number; interest: number }, debit: number, extraAs: ExtraAs = "late_fee"): {
  principal: number; interest: number; charges: number; difference: number; recompute: boolean;
} {
  const difference = debit - row.emi;
  if (difference === 0) return { principal: row.principal, interest: row.interest, charges: 0, difference, recompute: false };
  if (difference > 0) {
    return extraAs === "late_fee"
      ? { principal: row.principal, interest: row.interest, charges: difference, difference, recompute: false }
      : { principal: row.principal + difference, interest: row.interest, charges: 0, difference, recompute: true };
  }
  const interest = Math.min(row.interest, debit);
  return { principal: debit - interest, interest, charges: 0, difference, recompute: true };
}

/** Principal falling due within 12 months of `asOf` (current liability) vs later (non-current). */
export function currentVsNonCurrent(rows: { dueOn: string; principal: number; paid: boolean }[], asOf: string): { current: number; nonCurrent: number } {
  const cutoff = addMonthsIso(asOf, 12);
  let current = 0, nonCurrent = 0;
  for (const r of rows) {
    if (r.paid) continue;
    if (r.dueOn <= cutoff) current += r.principal; else nonCurrent += r.principal;
  }
  return { current, nonCurrent };
}
