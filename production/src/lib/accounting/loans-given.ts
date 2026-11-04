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

/** R-2340: "emi" = a fixed monthly receipt on a reducing balance (set up from a money-in bank line). */
export type RepaymentPlan = "one_shot" | "instalments" | "emi";

export interface LoanTerms {
  principal: number;
  givenOn: string;          // YYYY-MM-DD
  interestRate: number;     // % per year; 0 = interest-free
  plan: RepaymentPlan;
  dueOn: string | null;     // one_shot: the due date (null = no fixed date); instalments: first due date
  instalments: number | null;
  /** R-2340, plan "emi": the monthly receipt (dueOn = first receipt, instalments = number of receipts). */
  emi?: number | null;
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
  if (terms.plan === "emi") return emiLoanPosition(terms, repayments, asOf);
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
  if (terms.plan === "emi") {
    // R-2340: the month's interest on what is still owed (the server's rule), then principal.
    const left = Math.max(0, terms.principal - repayments.reduce((s, r) => s + r.principalPart, 0));
    const due = monthInterest(left, terms.interestRate);
    const amt = Math.max(0, Math.round(amount));
    const interestPart = Math.min(amt, due);
    const principalPart = amt - interestPart;
    const tooMuch = principalPart > left;
    return { interestPart, principalPart, maxAmount: left + due, tooMuch, closes: !tooMuch && amt > 0 && principalPart === left };
  }
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
  /** R-2340, plan "emi": the whole receipt (principal + that month's interest). */
  amount?: number;
}

/**
 * The repayment schedule (principal parts) and how much of each has been paid, as of `today`.
 * Principal repaid is applied to the rows in order.
 */
export function loanSchedule(terms: LoanTerms, principalRepaid: number, today: string): ScheduleRow[] {
  const parts: { dueOn: string | null; principal: number; amount?: number }[] = [];
  if (terms.plan === "emi" && terms.emi && terms.instalments && terms.dueOn) {
    for (const r of emiReceiptSchedule(terms.principal, terms.interestRate, terms.emi, terms.instalments, terms.dueOn)) {
      parts.push({ dueOn: r.dueOn, principal: r.principal, amount: r.amount });
    }
  } else if (terms.plan === "instalments" && terms.instalments && terms.instalments > 0 && terms.dueOn) {
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
    return { n: i + 1, dueOn: p.dueOn, principal: p.principal, cumulative, unpaid, state, ...(p.amount !== undefined ? { amount: p.amount } : {}) };
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

/* ══ R-2340: loan given with a monthly receipt (EMI), set up from a money-in bank line ══════════
 * The R-1864 / R-2323 reducing-balance rule, from the lender's side: each receipt's interest =
 * round(principal still owed × rate / 1200) — written the way the server works it out
 * (record_loan_given_from_bank / reconcile_bank_credit_to_loan_given, migration r2340), so the
 * preview and the booked split are the same rupee; principal = receipt − interest; the LAST receipt
 * clears what is left. The schedule is not stored — it follows from the terms and the receipts. */

/** One month's interest on `left` at `ratePct` a year, whole rupees. */
export function monthInterest(left: number, ratePct: number): number {
  if (!(left > 0) || !(ratePct > 0)) return 0;
  return Math.round((left * ratePct) / 1200);
}

export interface EmiReceiptRow {
  seq: number;
  dueOn: string;
  amount: number;
  principal: number;
  interest: number;
  balanceAfter: number;
}

/** The receipts of an EMI loan given, from the start (no receipt booked yet). */
export function emiReceiptSchedule(principal: number, ratePct: number, emi: number, months: number, firstDueOn: string): EmiReceiptRow[] {
  const P = Math.round(principal);
  const n = Math.round(months);
  const e = Math.round(emi);
  if (!(P > 0) || !(n > 0) || !(e > 0) || !firstDueOn) return [];
  const rows: EmiReceiptRow[] = [];
  let bal = P;
  for (let i = 0; i < n && bal > 0; i++) {
    const interest = monthInterest(bal, ratePct);
    const principalPart = i === n - 1 ? bal : Math.min(bal, Math.max(0, e - interest));
    bal -= principalPart;
    rows.push({ seq: i + 1, dueOn: addMonthsISO(firstDueOn, i), amount: principalPart + interest, principal: principalPart, interest, balanceAfter: bal });
  }
  return rows;
}

function emiLoanPosition(terms: LoanTerms, repayments: readonly RepaymentPart[], asOf: string): LoanPosition {
  let principalRepaid = 0;
  let interestReceived = 0;
  for (const r of repayments) {
    if (r.repaidOn > asOf) continue;
    principalRepaid += r.principalPart;
    interestReceived += r.interestPart;
  }
  const principalLeft = Math.max(0, terms.principal - principalRepaid);
  // Interest is charged with each receipt (on what is still owed), so nothing accrues in between.
  return { principalRepaid, interestReceived, principalLeft, interestDue: 0, outstanding: principalLeft };
}

export interface NextEmiReceipt { seq: number; amount: number; principal: number; interest: number; isLast: boolean }

/** The next receipt of an EMI loan given: what is expected and how it splits. null = nothing left. */
export function nextEmiReceipt(terms: LoanTerms, principalRepaid: number, receiptsSoFar: number): NextEmiReceipt | null {
  if (terms.plan !== "emi" || !terms.emi) return null;
  const left = terms.principal - principalRepaid;
  if (left <= 0) return null;
  const seq = receiptsSoFar + 1;
  const interest = monthInterest(left, terms.interestRate);
  const isLast = seq >= (terms.instalments ?? 1);
  const amount = isLast ? left + interest : Math.min(left + interest, terms.emi);
  return { seq, amount, principal: amount - interest, interest, isLast };
}

export interface LoanGivenForMatch {
  id: string;
  borrowerName: string;
  status: string;
  terms: LoanTerms;
  principalRepaid: number;
  receipts: number;
}

export interface LoanGivenReceiptMatch {
  loanId: string;
  borrowerName: string;
  /** The receipt number this line would be (receipts so far + 1). */
  seq: number;
  /** What the schedule expects (EMI plan), else null. */
  expected: number | null;
  confidence: "exact" | "low";
}

/** ₹1 either way still counts as the expected receipt (bank rounding). */
export const RECEIPT_AMOUNT_SLACK = 1;

/**
 * Which open loans given a money-in line of `credit` can be the next receipt of. An EMI loan whose
 * next receipt is this amount (±₹1) is "exact" and comes first; every other open loan is listed
 * as "low" so the owner can still pick it.
 */
export function matchLoanGivenReceipts(loans: readonly LoanGivenForMatch[], credit: number): LoanGivenReceiptMatch[] {
  const out: LoanGivenReceiptMatch[] = [];
  for (const l of loans) {
    if (l.status !== "open") continue;
    const next = nextEmiReceipt(l.terms, l.principalRepaid, l.receipts);
    if (l.terms.plan === "emi" && !next) continue;
    out.push({
      loanId: l.id, borrowerName: l.borrowerName, seq: l.receipts + 1, expected: next ? next.amount : null,
      confidence: next && Math.abs(next.amount - Math.round(credit)) <= RECEIPT_AMOUNT_SLACK ? "exact" : "low",
    });
  }
  return out.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "exact" ? -1 : 1));
}

export interface LoanGivenSetupInput {
  borrower: string;
  principal: number;
  annualRatePct: number;
  emi: number;
  months: number;
  firstDueOn: string;         // YYYY-MM-DD — the first receipt
  /** The money lent: an imported money-out line (its date is the date lent), or null = before these books. */
  disbursalTxnId: string | null;
}

export function loanGivenSetupErrors(i: LoanGivenSetupInput): string[] {
  const out: string[] = [];
  if (!i.borrower.trim()) out.push("Enter the borrower's name");
  if (!(i.principal > 0)) out.push("Enter the amount lent");
  if (!(i.annualRatePct >= 0 && i.annualRatePct <= 60)) out.push("Enter the interest rate (0 to 60% a year)");
  if (!(i.emi > 0)) out.push("Enter the monthly receipt (EMI)");
  if (!(i.months >= 1 && i.months <= 360)) out.push("Enter how many monthly receipts (1 to 360)");
  if (!i.firstDueOn) out.push("Enter the date of the first receipt");
  if (out.length === 0 && i.months > 1) {
    const first = monthInterest(Math.round(i.principal), i.annualRatePct);
    if (Math.round(i.emi) <= first) out.push(`The EMI does not cover the first month's interest (₹${first}) — check the rate or the EMI`);
  }
  return out;
}

/** The RPC payload of record_loan_given_from_bank. `reconcileTxnId` = this money-in line as receipt 1. */
export function loanGivenSetupPayload(i: LoanGivenSetupInput, reconcileTxnId: string | null) {
  return {
    borrower: i.borrower.trim(),
    borrower_type: "person",
    principal: Math.round(i.principal),
    interest_rate: i.annualRatePct,
    emi: Math.round(i.emi),
    instalments: Math.round(i.months),
    first_due_on: i.firstDueOn,
    disbursal_txn_id: i.disbursalTxnId,
    reconcile_txn_id: reconcileTxnId,
  };
}
