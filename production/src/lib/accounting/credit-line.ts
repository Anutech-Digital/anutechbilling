/**
 * R-2374 — a credit line (OD / flexi) from a lender, and the finance cost on it.
 *
 * OD audit (2 Nov 2026): a Bajaj Finance flexi / OD (₹40L drawn, interest-only ACH each month, a
 * ₹1.2L principal repay) could not be booked: the EMI loan needs a fixed schedule, and a debit
 * could not be split into principal + interest. Here (pure, no Supabase):
 *   - which expense heads are FINANCE COST (shown apart on the P&L, below operating expenses);
 *   - the repayment split check the server (reconcile_bank_debit_to_business_loan) repeats:
 *     principal + interest − TDS = the bank line (±₹1), principal ≤ outstanding, TDS ≤ interest;
 *   - which loans a bank line can go to, the one naming the lender first.
 *
 * MONEY (standard Indian treatment, Schedule III "Finance costs"):
 *   drawdown   Dr Bank / Cr Credit line (Borrowings)
 *   repayment  Dr Credit line (principal) + Dr Interest on loans / OD (P&L finance cost)
 *              / Cr Bank (the line) + Cr TDS payable u/s 194A (when the company keeps it back)
 */
import { lenderInNarration } from "@/lib/banking/loan-disbursal-lines";

/** The expense head the credit-line interest goes to (expense-categories.ts lists it). */
export const INTEREST_ON_LOANS = "Interest on loans / OD";

/** Expense heads that are finance cost: R-2374's head, and "Interest" — the head the EMI paths
 *  (record_loan_emi, R-1864 EMI split) have always booked loan interest to. */
export const FINANCE_COST_CATEGORIES: readonly string[] = [INTEREST_ON_LOANS, "Interest"];

export function isFinanceCost(category: string | null | undefined): boolean {
  return category != null && FINANCE_COST_CATEGORIES.includes(category);
}

/** The ₹1 rounding a bank line may differ by (paise) — the server's rule too. */
export const SPLIT_SLACK = 1;

export type LoanKind = "term" | "credit_line";

export interface LenderLoan {
  id: string;
  lender: string;
  kind: LoanKind;
  status: string;
  outstanding: number;
  creditLimit: number | null;
}

export interface RepaymentSplit {
  line: number;        // the bank debit
  principal: number;
  interest: number;
  tds: number;
  outstanding: number; // what is owed on the loan before this payment
}

/** Why this split cannot be saved — [] when it can. Plain words, one per problem. */
export function repaymentSplitErrors(s: RepaymentSplit): string[] {
  const out: string[] = [];
  const bad = (n: number) => !Number.isFinite(n) || n < 0 || !Number.isInteger(n);
  if (bad(s.principal) || bad(s.interest) || bad(s.tds)) {
    out.push("Principal, interest and TDS must be whole rupees, 0 or more.");
    return out;
  }
  if (s.principal + s.interest <= 0) out.push("Enter the principal or the interest of this payment.");
  if (s.tds > s.interest) out.push("TDS cannot be more than the interest.");
  if (s.principal > s.outstanding) out.push(`Principal is more than what is owed (${s.outstanding}).`);
  if (Math.abs(s.line - (s.principal + s.interest - s.tds)) > SPLIT_SLACK) {
    out.push("Principal + interest − TDS must equal the bank line.");
  }
  return out;
}

/** What is left to split as principal once the interest (and TDS kept back) is typed. */
export function principalFromLine(line: number, interest: number, tds: number): number {
  return Math.max(0, Math.round(line - interest + tds));
}

/** Money left on a credit line (limit − outstanding); null with no limit. Negative = over the limit. */
export function headroom(l: Pick<LenderLoan, "creditLimit" | "outstanding">): number | null {
  return l.creditLimit == null ? null : l.creditLimit - l.outstanding;
}

/**
 * The loans a bank line can be booked to: money in → credit lines only (a drawdown);
 * money out → credit lines with something owed or any active term loan. Loans the narration
 * names come first, then the most owed.
 */
export function loansForLine(loans: readonly LenderLoan[], dir: "in" | "out", description: string | null | undefined): LenderLoan[] {
  const ok = loans.filter((l) => dir === "in"
    ? l.kind === "credit_line"
    : (l.kind === "credit_line" ? l.outstanding > 0 : l.status === "active" && l.outstanding > 0));
  const named = (l: LenderLoan) => (lenderInNarration(description, l.lender) ? 1 : 0);
  return [...ok].sort((a, b) => named(b) - named(a) || b.outstanding - a.outstanding || a.lender.localeCompare(b.lender));
}
