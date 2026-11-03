/**
 * R-2388 — Private Vault → Loans (tables personal_loans / personal_loan_payments, view
 * personal_loan_balances, RPC personal_loan_record_payment — migration
 * 20261102194900_r2388_personal_loans.sql). Pure: no DB, no UI.
 *
 * Loans TAKEN (home, car, personal, …) are a liability: their outstanding joins card dues and
 * R-2386 owe/hold in `owedTotal`. Loans GIVEN (money lent to a person) are an asset: money owed
 * to you. Outstanding = principal − principal repaid.
 *
 * EMI maths = reducing balance, the way Indian banks quote it:
 *   EMI = P × r × (1+r)^n / ((1+r)^n − 1), r = annual rate / 12 / 100
 *   each month: interest = round(outstanding × r), principal = EMI − interest.
 * The SQL RPC uses the SAME rounding (round half up on a positive number), so the split the
 * screen shows is the split the database books. All amounts are whole rupees.
 */

export type LoanDirection = "taken" | "given";
export type LoanKind = "home" | "car" | "personal" | "education" | "gold" | "overdraft" | "person" | "other";
export type RepayType = "emi" | "interest_only" | "no_interest";
export type LoanStatus = "open" | "closed";
export type LoanPaymentKind = "emi" | "prepayment" | "interest" | "repayment";

export const TAKEN_KINDS: readonly LoanKind[] = ["home", "car", "personal", "education", "gold", "overdraft", "person", "other"];
export const GIVEN_KINDS: readonly LoanKind[] = ["person", "other"];

export const LOAN_KIND_LABEL: Record<LoanKind, string> = {
  home: "Home loan",
  car: "Car / vehicle loan",
  personal: "Personal loan",
  education: "Education loan",
  gold: "Gold loan",
  overdraft: "Overdraft / credit line",
  person: "From / to a person",
  other: "Other",
};

/** Kind label when lending: "From / to a person" reads oddly there. */
export function loanKindLabel(kind: LoanKind, direction: LoanDirection): string {
  if (kind === "person") return direction === "given" ? "To a person" : "From a person";
  return LOAN_KIND_LABEL[kind];
}

export const REPAY_TYPES: readonly RepayType[] = ["emi", "interest_only", "no_interest"];
export const REPAY_TYPE_LABEL: Record<RepayType, string> = {
  emi: "EMI (principal + interest)",
  interest_only: "Interest only (principal at the end)",
  no_interest: "No interest",
};

export const PAYMENT_KIND_LABEL: Record<LoanPaymentKind, string> = {
  emi: "EMI",
  prepayment: "Prepayment",
  interest: "Interest",
  repayment: "Repayment",
};

export interface LoanLike {
  id: string;
  direction: LoanDirection;
  loan_kind: LoanKind;
  party: string;
  principal: number;
  /** YYYY-MM-DD */
  start_date: string;
  annual_rate: number | null;
  repay_type: RepayType;
  tenure_months: number | null;
  emi_amount: number | null;
  first_due_on: string | null;
  status: LoanStatus;
}

export interface LoanPaymentLike {
  loan_id: string;
  kind: LoanPaymentKind;
  /** YYYY-MM-DD */
  paid_on: string;
  principal_part: number;
  interest_part: number;
}

function rupees(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function rate(annual: number | null | undefined): number {
  const n = Number(annual ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The month's interest on an outstanding, whole rupees (same as the SQL RPC). */
export function monthlyInterest(outstanding: number, annualRate: number | null): number {
  return Math.round((rupees(outstanding) * rate(annualRate)) / 1200);
}

/**
 * Reducing-balance EMI, rounded to the rupee. Rate 0 → principal spread evenly (rounded up so
 * the last instalment is never bigger). Returns 0 when principal or months is missing.
 */
export function computeEmi(principal: number, annualRate: number | null, months: number | null): number {
  const p = rupees(principal);
  const n = Math.round(Number(months ?? 0));
  if (p <= 0 || !Number.isFinite(n) || n <= 0) return 0;
  const r = rate(annualRate) / 1200;
  if (r === 0) return Math.ceil(p / n);
  const f = Math.pow(1 + r, n);
  return Math.round((p * r * f) / (f - 1));
}

/** The next EMI's split on the current outstanding — what "Mark paid" books. */
export function splitEmi(outstanding: number, annualRate: number | null, emi: number): { interest: number; principal: number } {
  const out = Math.max(0, rupees(outstanding));
  const interest = Math.min(monthlyInterest(out, annualRate), rupees(emi));
  const principal = Math.min(rupees(emi) - interest, out);
  return { interest, principal };
}

/** YYYY-MM-DD plus n months; the day is kept, or the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonthsISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Date of the first EMI / interest payment: as typed, else one month after the start. */
export function firstDueOn(loan: Pick<LoanLike, "first_due_on" | "start_date">): string {
  return loan.first_due_on || addMonthsISO(loan.start_date, 1);
}

export interface LoanSummary {
  principalPaid: number;
  interestPaid: number;
  outstanding: number;
  /** Instalments paid: EMIs (EMI loans) or interest payments (interest-only loans). */
  instalmentsPaid: number;
  lastPaidOn: string | null;
}

export function summariseLoan(loan: Pick<LoanLike, "id" | "principal">, payments: readonly LoanPaymentLike[]): LoanSummary {
  let principalPaid = 0;
  let interestPaid = 0;
  let instalmentsPaid = 0;
  let lastPaidOn: string | null = null;
  for (const p of payments) {
    if (p.loan_id !== loan.id) continue;
    principalPaid += rupees(p.principal_part);
    interestPaid += rupees(p.interest_part);
    if (p.kind === "emi" || p.kind === "interest") instalmentsPaid++;
    if (!lastPaidOn || p.paid_on > lastPaidOn) lastPaidOn = p.paid_on;
  }
  return {
    principalPaid,
    interestPaid,
    outstanding: Math.max(0, rupees(loan.principal) - principalPaid),
    instalmentsPaid,
    lastPaidOn,
  };
}

/**
 * The tenure's last EMI takes whatever principal is left: the EMI is rounded to the rupee and
 * so is each month's interest, which leaves a few rupees after instalment n (banks fold that
 * into the last EMI rather than adding an instalment n+1).
 */
function isLastInstalment(loan: Pick<LoanLike, "tenure_months">, instalmentNo: number): boolean {
  return loan.tenure_months != null && loan.tenure_months > 0 && instalmentNo >= loan.tenure_months;
}

export interface NextDue {
  dueOn: string;
  amount: number;
  /** For an EMI: its split. Interest-only: all interest. */
  interest: number;
  principal: number;
  instalmentNo: number;
}

/**
 * The next instalment of an OPEN loan, or null (closed, no-interest, nothing left, no EMI set).
 * Due date = first due + instalments already paid (months).
 */
export function nextDue(loan: LoanLike, summary: LoanSummary): NextDue | null {
  if (loan.status !== "open" || summary.outstanding <= 0) return null;
  const no = summary.instalmentsPaid + 1;
  const dueOn = addMonthsISO(firstDueOn(loan), summary.instalmentsPaid);
  if (loan.repay_type === "emi") {
    const emi = rupees(loan.emi_amount);
    if (emi <= 0) return null;
    const s = splitEmi(summary.outstanding, loan.annual_rate, emi);
    if (isLastInstalment(loan, no)) s.principal = summary.outstanding;
    return { dueOn, amount: s.interest + s.principal, interest: s.interest, principal: s.principal, instalmentNo: no };
  }
  if (loan.repay_type === "interest_only") {
    const interest = monthlyInterest(summary.outstanding, loan.annual_rate);
    if (interest <= 0) return null;
    return { dueOn, amount: interest, interest, principal: 0, instalmentNo: no };
  }
  return null;
}

export interface ScheduleRow {
  no: number;
  dueOn: string;
  opening: number;
  interest: number;
  principal: number;
  closing: number;
  /** "paid" = a recorded payment; "due" = the next one; "planned" = later. */
  state: "paid" | "due" | "planned";
  kind: LoanPaymentKind;
  paidOn?: string;
}

/**
 * The EMI schedule: the recorded payments first (in date order, with their real split —
 * prepayments included as their own rows), then the planned instalments on the CURRENT
 * outstanding with the same EMI (so a prepayment shortens the loan, the way banks do it by
 * default). Interest-only: the next `horizon` months of interest. No-interest: payments only.
 */
export function buildSchedule(loan: LoanLike, payments: readonly LoanPaymentLike[], horizon = 12): ScheduleRow[] {
  const mine = payments
    .filter((p) => p.loan_id === loan.id)
    .slice()
    .sort((a, b) => (a.paid_on === b.paid_on ? 0 : a.paid_on < b.paid_on ? -1 : 1));
  const rows: ScheduleRow[] = [];
  let outstanding = rupees(loan.principal);
  let instalments = 0;
  for (const p of mine) {
    const principal = rupees(p.principal_part);
    const isInstalment = p.kind === "emi" || p.kind === "interest";
    if (isInstalment) instalments++;
    rows.push({
      no: isInstalment ? instalments : 0,
      dueOn: isInstalment ? addMonthsISO(firstDueOn(loan), instalments - 1) : p.paid_on,
      opening: outstanding,
      interest: rupees(p.interest_part),
      principal,
      closing: Math.max(0, outstanding - principal),
      state: "paid",
      kind: p.kind,
      paidOn: p.paid_on,
    });
    outstanding = Math.max(0, outstanding - principal);
  }
  if (loan.status !== "open" || outstanding <= 0) return rows;

  const emi = rupees(loan.emi_amount);
  const limit = loan.repay_type === "emi" ? 1200 : loan.repay_type === "interest_only" ? horizon : 0;
  for (let i = 0; i < limit && outstanding > 0; i++) {
    let interest: number;
    let principal: number;
    if (loan.repay_type === "emi") {
      if (emi <= 0) break;
      ({ interest, principal } = splitEmi(outstanding, loan.annual_rate, emi));
      if (principal <= 0) break; // EMI does not even cover the interest — never ends
      if (isLastInstalment(loan, instalments + 1)) principal = outstanding;
    } else {
      interest = monthlyInterest(outstanding, loan.annual_rate);
      principal = 0;
      if (interest <= 0) break;
    }
    instalments++;
    rows.push({
      no: instalments,
      dueOn: addMonthsISO(firstDueOn(loan), instalments - 1),
      opening: outstanding,
      interest,
      principal,
      closing: outstanding - principal,
      state: i === 0 ? "due" : "planned",
      kind: loan.repay_type === "emi" ? "emi" : "interest",
    });
    outstanding -= principal;
  }
  return rows;
}

export interface LoanTotals {
  /** Open loans you gave — money owed TO you (asset). */
  givenOutstanding: number;
  /** Open loans you took — money you owe (liability). */
  takenOutstanding: number;
  /** The soonest next instalment across open TAKEN loans (the reminder). */
  nextEmi: (NextDue & { loanId: string; party: string }) | null;
}

export function loanTotals(loans: readonly LoanLike[], payments: readonly LoanPaymentLike[]): LoanTotals {
  let givenOutstanding = 0;
  let takenOutstanding = 0;
  let nextEmi: LoanTotals["nextEmi"] = null;
  for (const l of loans) {
    if (l.status !== "open") continue;
    const s = summariseLoan(l, payments);
    if (l.direction === "given") givenOutstanding += s.outstanding;
    else {
      takenOutstanding += s.outstanding;
      const nd = nextDue(l, s);
      if (nd && (!nextEmi || nd.dueOn < nextEmi.dueOn)) nextEmi = { ...nd, loanId: l.id, party: l.party };
    }
  }
  return { givenOutstanding, takenOutstanding, nextEmi };
}

/** Indian financial year (April–March) holding a YYYY-MM-DD date: {start, end, label "2026-27"}. */
export function financialYear(iso: string): { start: string; end: string; label: string } {
  const [y, m] = iso.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

/** Section 24(b) cap for a self-occupied house (₹2 lakh) and the 80C cap (₹1.5 lakh, all of 80C). */
export const SEC_24B_SELF_OCCUPIED_CAP = 200000;
export const SEC_80C_CAP = 150000;

export interface HomeLoanItr {
  /** Home-loan interest paid in the FY — Section 24(b). */
  interest: number;
  /** Home-loan principal repaid in the FY (EMIs + prepayments) — Section 80C. */
  principal: number;
  loans: number;
}

/** Home-loan interest (24b) and principal (80C) paid in the FY [start, end]. Taken home loans only. */
export function homeLoanItr(
  loans: readonly LoanLike[],
  payments: readonly LoanPaymentLike[],
  fy: { start: string; end: string },
): HomeLoanItr {
  const homeIds = new Set(loans.filter((l) => l.direction === "taken" && l.loan_kind === "home").map((l) => l.id));
  let interest = 0;
  let principal = 0;
  for (const p of payments) {
    if (!homeIds.has(p.loan_id) || p.paid_on < fy.start || p.paid_on > fy.end) continue;
    interest += rupees(p.interest_part);
    principal += rupees(p.principal_part);
  }
  return { interest, principal, loans: homeIds.size };
}
