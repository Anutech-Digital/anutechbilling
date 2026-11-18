/**
 * R-2920 — one money-in bank line paid across TWO OR MORE loans given.
 *
 * Banking → Reconcile → Loan / EMI → "A receipt on a loan you gave?": the owner ticks the loans the
 * line pays; each ticked loan gets an amount (filled oldest loan first, each up to what it still
 * owes), and Save is on only when the amounts add up to the bank line and none is more than is owed.
 * Each loan's amount splits into principal + interest by the loan's own rule (splitRepayment) — the
 * RPC reconcile_bank_credit_to_loans_given re-checks all of it.
 *
 * Pure functions (unit-tested in loan-given-split-r2920.test.ts); whole rupees.
 */
import { splitRepayment, type LoanGivenReceiptMatch, type LoanTerms, type RepaymentPart } from "./loans-given";

/** What this file needs of a loan given (a LoanGiven from lib/queries/loans-given fits). */
export interface SplitLoan {
  id: string;
  borrower_name: string;
  given_on: string;
  terms: LoanTerms;
  parts: readonly RepaymentPart[];
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Is this borrower named in the bank line's narration? "Kapil Dev" is in "NEFT CR-KAPIL DEV-HDFC…"
 * and in "UPI/KAPILDEV@okaxis" (a joined name counts only from 6 letters, so "Raj" is not found
 * inside "Rajesh Traders").
 */
export function borrowerInNarration(borrowerName: string, narration: string | null | undefined): boolean {
  const name = plain(borrowerName);
  const text = plain(narration ?? "");
  if (!name || !text) return false;
  if (` ${text} `.includes(` ${name} `)) return true;
  const joined = name.replace(/ /g, "");
  return joined.length >= 6 && text.replace(/ /g, "").includes(joined);
}

export interface LoanChoice extends LoanGivenReceiptMatch {
  /** The borrower's name is in the bank line's narration. */
  named: boolean;
}

/**
 * The list the owner picks from: an exact next receipt first (R-2340), then the loans whose borrower
 * is named in the narration (oldest loan first — one person's loans sit together), then the rest.
 */
export function orderLoanChoices(
  matches: readonly LoanGivenReceiptMatch[], loans: readonly SplitLoan[], narration: string | null | undefined,
): LoanChoice[] {
  const givenOn = new Map(loans.map((l) => [l.id, l.given_on]));
  const rank = (c: LoanChoice) => (c.confidence === "exact" ? 0 : c.named ? 1 : 2);
  return matches
    .map((m, i) => ({ c: { ...m, named: borrowerInNarration(m.borrowerName, narration) }, i }))
    .sort((a, b) => {
      const d = rank(a.c) - rank(b.c);
      if (d !== 0) return d;
      if (rank(a.c) === 1) {
        const ga = givenOn.get(a.c.loanId) ?? "";
        const gb = givenOn.get(b.c.loanId) ?? "";
        if (ga !== gb) return ga < gb ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** The most that can come in on this loan on `date` (principal left + interest due). */
export function maxOnLoan(loan: SplitLoan, date: string): number {
  return splitRepayment(loan.terms, loan.parts, date, 0).maxAmount;
}

/**
 * Which loans are ticked before the owner touches anything:
 *   • an exact next receipt (R-2340) → that loan alone;
 *   • else the loans of the borrower named in the narration, oldest first, as many as the line
 *     needs (a ₹3,50,000 line with ₹3,49,000 + ₹1,000 owed ticks both);
 *   • else NONE — never just the first loan in the list (it may be someone else's).
 */
export function defaultTicked(choices: readonly LoanChoice[], loans: readonly SplitLoan[], date: string, bankAmount: number): string[] {
  const exact = choices.find((c) => c.confidence === "exact");
  if (exact) return [exact.loanId];
  const byId = new Map(loans.map((l) => [l.id, l]));
  const out: string[] = [];
  let left = Math.round(bankAmount);
  for (const c of choices) {
    if (!c.named) continue;
    if (out.length > 0 && left <= 0) break;
    const loan = byId.get(c.loanId);
    if (!loan) continue;
    out.push(c.loanId);
    left -= maxOnLoan(loan, date);
  }
  return out;
}

/** A whole-rupee amount typed in a field; "" / junk / negative / paise ("100.5", R-2921 — never rounded) → null. */
export function typedRupees(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface ReceiptPart {
  loanId: string;
  borrowerName: string;
  amount: number;
  principalPart: number;
  interestPart: number;
  /** The most this loan can take on the line's date. */
  maxAmount: number;
  tooMuch: boolean;
  closes: boolean;
  /** What the RPC is handed: null on an EMI loan (the server works its interest out). */
  interestForRpc: number | null;
}

export interface ReceiptPlan {
  parts: ReceiptPart[];
  total: number;
  /** total − bank line: 0 = tallies, negative = still to place, positive = too much. */
  difference: number;
  tallies: boolean;
  canSave: boolean;
}

/**
 * The amounts of the ticked loans and whether the line can be saved. An amount the owner typed is
 * kept; the others are filled oldest loan first, each up to what it still owes, from what is left
 * of the bank line. One ticked loan with nothing typed takes the whole line (the R-2340 flow).
 */
export function receiptPlan(
  ticked: readonly SplitLoan[], typed: Readonly<Record<string, number | null | undefined>>, date: string, bankAmount: number,
): ReceiptPlan {
  const bank = Math.round(bankAmount);
  const max = new Map(ticked.map((l) => [l.id, maxOnLoan(l, date)]));
  const amounts = new Map<string, number>();
  let left = bank;
  for (const l of ticked) {
    const t = typed[l.id];
    if (t !== null && t !== undefined) { amounts.set(l.id, t); left -= t; }
  }
  const auto = ticked
    .filter((l) => !amounts.has(l.id))
    .sort((a, b) => (a.given_on === b.given_on ? 0 : a.given_on < b.given_on ? -1 : 1));
  if (ticked.length === 1 && auto.length === 1) {
    amounts.set(auto[0].id, bank);   // the whole line — "more than is owed" is then said, as before
  } else {
    for (const l of auto) {
      const a = Math.max(0, Math.min(left, max.get(l.id) ?? 0));
      amounts.set(l.id, a);
      left -= a;
    }
  }
  const parts: ReceiptPart[] = ticked.map((l) => {
    const amount = amounts.get(l.id) ?? 0;
    const s = splitRepayment(l.terms, l.parts, date, amount);
    return {
      loanId: l.id, borrowerName: l.borrower_name, amount, principalPart: s.principalPart, interestPart: s.interestPart,
      maxAmount: s.maxAmount, tooMuch: s.tooMuch, closes: s.closes,
      interestForRpc: l.terms.plan === "emi" ? null : s.interestPart,
    };
  });
  const total = parts.reduce((s, p) => s + p.amount, 0);
  const tallies = total === bank;
  return {
    parts, total, difference: total - bank, tallies,
    canSave: parts.length > 0 && tallies && parts.every((p) => p.amount > 0 && !p.tooMuch),
  };
}
