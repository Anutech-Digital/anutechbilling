/**
 * R-2674: loans given / staff loans due back within 12 months are CURRENT assets.
 *
 * The rule itself lives in SQL — `loans_current_split()` (migration 20261111201800): a loan with
 * a due date / schedule follows it (the unpaid principal parts due by Balance Sheet date + 12
 * months are current), a loan with no due date follows the owner's / accountant's answer, a staff
 * loan is current unless marked otherwise. This file only shapes that answer for the screens:
 * the Balance Sheet lines, the current ratio (balance-sheet-totals.ts) and the CSV all read
 * `loansAdvancesSplit()` — one object, so they cannot disagree.
 *
 * Totals never change: current is clamped to the Balance Sheet's own line (0 … total) and
 * non-current is the rest, so current + non-current = the old single line. Whole rupees.
 */

/** What `loans_current_split()` answers (jsonb). */
export interface LoansCurrentRpcRow {
  as_of?: string;
  loans_given_current?: number | string | null;
  employee_loans_current?: number | string | null;
  loans_given_undecided?: number | string | null;
  loans_given_undecided_amount?: number | string | null;
}

/** The current parts, as carried on BalanceSheetAuto. Absent (older database) = nothing is current, as before R-2674. */
export interface LoansCurrent {
  loansGiven: number;
  employeeLoans: number;
  /** Loans given with no due date and no answer yet (they stay non-current until answered). */
  undecidedCount: number;
  undecidedAmount: number;
}

function whole(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function loansCurrentFromRpc(row: LoansCurrentRpcRow | null | undefined): LoansCurrent {
  return {
    loansGiven: whole(row?.loans_given_current),
    employeeLoans: whole(row?.employee_loans_current),
    undecidedCount: whole(row?.loans_given_undecided),
    undecidedAmount: whole(row?.loans_given_undecided_amount),
  };
}

export interface CurrentPart { total: number; current: number; nonCurrent: number }

export interface LoansAdvancesSplit {
  /** Loans given (outside parties, directors). */
  given: CurrentPart;
  /** Employee loans / salary + expense advances. */
  staff: CurrentPart;
  /** given.current + staff.current — what the current ratio counts. */
  current: number;
  nonCurrent: number;
  undecidedCount: number;
  undecidedAmount: number;
  /** false = the database has no loans_current_split() yet — nothing is known about due dates, the sheet shows the plain lines as before. */
  known: boolean;
}

function part(total: number, current: number): CurrentPart {
  const t = Math.max(0, total);
  const c = Math.min(t, Math.max(0, current));
  return { total: t, current: c, nonCurrent: t - c };
}

/** The ONE split the Balance Sheet lines, the current ratio and the CSV read. */
export function loansAdvancesSplit(
  auto: { loansGiven?: number; employeeLoans?: number; loansCurrent?: LoansCurrent | null } | null | undefined,
): LoansAdvancesSplit {
  const lc = auto?.loansCurrent;
  const given = part(auto?.loansGiven ?? 0, lc?.loansGiven ?? 0);
  const staff = part(auto?.employeeLoans ?? 0, lc?.employeeLoans ?? 0);
  const undecidedAmount = Math.min(given.nonCurrent, Math.max(0, lc?.undecidedAmount ?? 0));
  return {
    known: lc != null,
    given, staff,
    current: given.current + staff.current,
    nonCurrent: given.nonCurrent + staff.nonCurrent,
    undecidedCount: undecidedAmount > 0 ? Math.max(0, lc?.undecidedCount ?? 0) : 0,
    undecidedAmount,
  };
}

export interface LoanSplitLine {
  key: "staff" | "given";
  /** current / non_current = decided (schedule or answer); undecided = no due date, not answered (counted as non-current); plain = split not known. */
  place: "current" | "non_current" | "undecided" | "plain";
  /** Counted in current assets. */
  current: boolean;
  label: string;
  amount: number;
}

/**
 * Balance Sheet / CSV rows for the two loan lines — only the parts that hold money. A loan given
 * with no due date and no answer is its OWN row (never printed as "due after 12 months" — nobody
 * said so). When the split is not known (older database) the two plain lines are shown as before.
 */
export function loanSplitLines(s: LoansAdvancesSplit): LoanSplitLine[] {
  const out: LoanSplitLine[] = [];
  const add = (key: "staff" | "given", name: string, p: CurrentPart, undecided: number) => {
    if (!s.known) {
      if (p.total > 0) out.push({ key, place: "plain", current: false, label: name, amount: p.total });
      return;
    }
    const later = p.nonCurrent - undecided;
    if (p.current > 0) out.push({ key, place: "current", current: true, label: `${name} — current (due within 12 months)`, amount: p.current });
    if (later > 0) out.push({ key, place: "non_current", current: false, label: `${name} — non-current (due after 12 months)`, amount: later });
    if (undecided > 0) out.push({ key, place: "undecided", current: false, label: `${name} — no due date, not answered (counted as non-current)`, amount: undecided });
  };
  add("staff", "Employee loans", s.staff, 0);
  add("given", "Loans given", s.given, s.undecidedAmount);
  return out;
}

/** The hint under a Balance Sheet loan line. */
export function loanSplitLineHint(l: Pick<LoanSplitLine, "key" | "place">, undecidedCount: number): string {
  if (l.key === "staff") {
    return l.place === "current" ? "lent to staff, owed back — counted in the current ratio (office-expense advances are their own line)"
      : l.place === "non_current" ? "staff loans marked as due back after 12 months on Loans & Salary Advances"
      : "lent to staff, owed back (office-expense advances are their own line)";
  }
  return l.place === "current" ? "lent to outside parties, due back within 12 months — counted in the current ratio"
    : l.place === "non_current" ? "lent to outside parties, due back after 12 months"
    : l.place === "undecided" ? `${undecidedCount === 1 ? "1 loan" : `${undecidedCount} loans`} with no due date — the owner or accountant answers "Due back within 12 months?" on Loans given`
    : "lent to outside parties, still owed back";
}

export const DUE_WITHIN_LABEL = "Due back within 12 months?";

/** One loan given, as `loans_given_current_parts()` answers it. */
export interface LoanGivenCurrentPart {
  loan_id: string;
  principal_left: number;
  current_part: number;
  basis: "schedule" | "choice" | "undecided";
}

/** What the Loans given card says about where the loan shows on the Balance Sheet. */
export function loanGivenSplitNote(p: Pick<LoanGivenCurrentPart, "principal_left" | "current_part" | "basis"> | undefined, money: (n: number) => string = String): string | null {
  if (!p || p.principal_left <= 0) return null;
  if (p.basis === "undecided") return "Balance Sheet: non-current until you answer";
  const rest = p.principal_left - p.current_part;
  if (p.current_part <= 0) return "Balance Sheet: non-current (due after 12 months)";
  if (rest <= 0) return "Balance Sheet: current (due within 12 months)";
  return `Balance Sheet: ${money(p.current_part)} current (due within 12 months) · ${money(rest)} non-current`;
}
