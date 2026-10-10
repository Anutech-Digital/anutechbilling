/**
 * Loans given (R-544) — the money maths for loans this business lends to OUTSIDE parties.
 * Pure functions, unit-tested in loans-given.test.ts. The page and the repayment dialog both
 * read from here, and the `record_loan_repayment` RPC (migration 20261010140000) re-checks
 * the split it is handed, so the browser cannot book more than is owed.
 *
 * RULES
 *   • Whole rupees in and out (CLAUDE.md §13). Interest is accrued as a fraction while it is
 *     being counted and rounded ONCE, when a figure is shown or booked.
 *   • Simple interest on the principal still outstanding, per day / 365. 0% = interest-free.
 *   • A repayment pays the interest accrued up to its date FIRST, then principal.
 *   • Outstanding = principal left + interest accrued and unpaid. Never negative.
 *   • The loan is closed when no principal is left.
 *   • Plan "instalments": N equal monthly PRINCIPAL parts (the last one takes the rounding),
 *     the first on `dueOn`; interest is charged on top on what is still owed.
 *     Plan "one_shot": all principal due on `dueOn` (or no fixed date when it is null).
 */
import { daysBetweenISO } from "@/lib/dates/ist";

export type RepaymentPlan = "one_shot" | "instalments";

export interface LoanTerms {
  principal: number;
  givenOn: string;          // YYYY-MM-DD
  interestRate: number;     // % per year; 0 = interest-free
  plan: RepaymentPlan;
  dueOn: string | null;     // one_shot: the due date (null = no fixed date); instalments: first due date
  instalments: number | null;
}

export interface RepaymentPart {
  repaidOn: string;
  amount: number;
  principalPart: number;
  interestPart: number;
}

export interface LoanPosition {
  principalRepaid: number;
  interestReceived: number;
  principalLeft: number;
  /** Interest accrued up to `asOf` and not yet received (whole rupees). */
  interestDue: number;
  /** principalLeft + interestDue. */
  outstanding: number;
}

/** Interest on `amount` at `ratePct`/yr for `days` days — a fraction, not yet rounded. */
export function simpleInterest(amount: number, ratePct: number, days: number): number {
  if (amount <= 0 || ratePct <= 0 || days <= 0) return 0;
  return (amount * ratePct * days) / 36_500;
}

function byDate(a: RepaymentPart, b: RepaymentPart): number {
  return a.repaidOn < b.repaidOn ? -1 : a.repaidOn > b.repaidOn ? 1 : 0;
}

/**
 * Where the loan stands on `asOf`: principal left, interest accrued and unpaid, outstanding.
 * Repayments after `asOf` are ignored. Interest runs between events on the principal
 * that was outstanding during that stretch.
 */
export function loanPosition(terms: LoanTerms, repayments: readonly RepaymentPart[], asOf: string): LoanPosition {
  let principalLeft = terms.principal;
  let interestAccrued = 0;   // fraction
  let interestReceived = 0;
  let principalRepaid = 0;
  let last = terms.givenOn;

  for (const r of [...repayments].sort(byDate)) {
    if (r.repaidOn > asOf) break;
    interestAccrued += simpleInterest(principalLeft, terms.interestRate, daysBetweenISO(last, r.repaidOn));
    last = r.repaidOn > last ? r.repaidOn : last;
    principalLeft = Math.max(0, principalLeft - r.principalPart);
    principalRepaid += r.principalPart;
    interestReceived += r.interestPart;
  }
  if (asOf > last) interestAccrued += simpleInterest(principalLeft, terms.interestRate, daysBetweenISO(last, asOf));

  const interestDue = Math.max(0, Math.round(interestAccrued - interestReceived));
  return {
    principalRepaid,
    interestReceived,
    principalLeft,
    interestDue,
    outstanding: principalLeft + interestDue,
  };
}

/**
 * How a new repayment of `amount` on `repaidOn` splits: interest due first, then principal.
 * `tooMuch` = the amount is more than the whole outstanding (the RPC refuses it too);
 * `maxAmount` is the most that can be taken on that date.
 */
export function splitRepayment(
  terms: LoanTerms, repayments: readonly RepaymentPart[], repaidOn: string, amount: number,
): { interestPart: number; principalPart: number; maxAmount: number; tooMuch: boolean; closes: boolean } {
  const pos = loanPosition(terms, repayments, repaidOn);
  const amt = Math.max(0, Math.round(amount));
  const interestPart = Math.min(amt, pos.interestDue);
  const principalPart = amt - interestPart;
  const tooMuch = principalPart > pos.principalLeft;
  return {
    interestPart,
    principalPart,
    maxAmount: pos.outstanding,
    tooMuch,
    closes: !tooMuch && amt > 0 && principalPart === pos.principalLeft,
  };
}

/** YYYY-MM-DD + n calendar months; a 31st falls back to the month's last day. */
export function addMonthsISO(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const d = Number(iso.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export type ScheduleState = "paid" | "part" | "overdue" | "due";

export interface ScheduleRow {
  n: number;
  dueOn: string | null;
  /** Principal due in this instalment. */
  principal: number;
  /** Principal due up to and including this row. */
  cumulative: number;
  /** Principal of THIS row still unpaid. */
  unpaid: number;
  state: ScheduleState;
}

/**
 * The repayment schedule (principal parts) and how much of each has been paid, as of `today`.
 * Principal repaid is applied to the rows in order.
 */
export function loanSchedule(terms: LoanTerms, principalRepaid: number, today: string): ScheduleRow[] {
  const parts: { dueOn: string | null; principal: number }[] = [];
  if (terms.plan === "instalments" && terms.instalments && terms.instalments > 0 && terms.dueOn) {
    const n = terms.instalments;
    const each = Math.floor(terms.principal / n);
    for (let i = 0; i < n; i++) {
      parts.push({
        dueOn: addMonthsISO(terms.dueOn, i),
        principal: i === n - 1 ? terms.principal - each * (n - 1) : each,
      });
    }
  } else {
    parts.push({ dueOn: terms.dueOn, principal: terms.principal });
  }

  let cumulative = 0;
  return parts.map((p, i) => {
    const before = cumulative;
    cumulative += p.principal;
    const paidHere = Math.min(p.principal, Math.max(0, principalRepaid - before));
    const unpaid = p.principal - paidHere;
    const state: ScheduleState =
      unpaid === 0 ? "paid"
      : p.dueOn !== null && p.dueOn < today ? "overdue"
      : paidHere > 0 ? "part"
      : "due";
    return { n: i + 1, dueOn: p.dueOn, principal: p.principal, cumulative, unpaid, state };
  });
}

/** The first schedule row not fully paid, or null when everything is repaid. */
export function nextDue(rows: readonly ScheduleRow[]): ScheduleRow | null {
  return rows.find((r) => r.unpaid > 0) ?? null;
}

/** Principal that should have come back by `today` but has not. 0 = not overdue. */
export function overdueAmount(rows: readonly ScheduleRow[]): number {
  return rows.filter((r) => r.state === "overdue").reduce((s, r) => s + r.unpaid, 0);
}

/** Roles that may see and work this screen (card R-544: owner / accountant only).
 *  The RLS read policy and every RPC check the same two roles. */
export const LOANS_GIVEN_ROLES = ["owner", "accountant"] as const;

export function canUseLoansGiven(role: string | null | undefined): boolean {
  return role != null && (LOANS_GIVEN_ROLES as readonly string[]).includes(role);
}
