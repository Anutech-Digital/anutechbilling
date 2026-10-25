/**
 * R-1895 (25 Oct 2026): a salary in the Salary Register → the bank-statement line that paid it.
 *
 * The link is already in the data: the trigger sync_salary_paid_status sets
 * salary_payments.reconciled_txn_id when a bank line fully pays the salary (a split line sets it
 * too). When it is empty but a line still points at the salary (bank_transactions.matched_to_type
 * 'salary' → the salary id, or 'expense' → its expense id) that line is used — newest first.
 *
 *   • linked line (Paid / Partial) → open /accounting/banking/<account>?txn=<line>
 *   • Paid, no line anywhere        → "Not matched to bank" + Match (the bank reconcile flow)
 *   • Not paid yet / link-bank-line → nothing here (the status cell already says what to do)
 */
import { salaryPayState, salaryBankLineKey, type SalaryPayFacts } from "./salary-status";

export type SalaryLinkFacts = SalaryPayFacts & {
  id: string;
  reconciled_txn_id: string | null;
  expense_id?: string | null;
};

/** The bank-line fields this needs (a bank_transactions row has them all). */
export type BankLineFacts = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  matched_to_type: string | null;
  matched_to_id: string | null;
};

export type BankLineRef = { txnId: string; accountId: string };

export type SalaryBankLink =
  | { kind: "open"; href: string }
  | { kind: "not_matched"; matchHref: string }
  | { kind: "none" };

export const bankLineHref = (ref: BankLineRef) => `/accounting/banking/${ref.accountId}?txn=${ref.txnId}`;

/** Which bank line each salary points at (salary id → line). Salaries with none are left out. */
export function resolveSalaryBankLines(
  salaries: readonly SalaryLinkFacts[],
  lines: readonly BankLineFacts[],
): Map<string, BankLineRef> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  // Newest line wins when several point at the same salary (partial payments).
  const newestFirst = [...lines].sort((a, b) => b.txn_date.localeCompare(a.txn_date) || b.id.localeCompare(a.id));
  const out = new Map<string, BankLineRef>();
  for (const s of salaries) {
    const direct = s.reconciled_txn_id ? byId.get(s.reconciled_txn_id) : undefined;
    const line = direct ?? newestFirst.find((l) =>
      (l.matched_to_type === "salary" && l.matched_to_id === s.id)
      || (l.matched_to_type === "expense" && !!s.expense_id && l.matched_to_id === s.expense_id));
    if (line) out.set(s.id, { txnId: line.id, accountId: line.bank_account_id });
  }
  return out;
}

/**
 * @param waitingAccountId  a bank account holding an unlinked money-out line of exactly this net
 *                          (useUnlinkedSalaryBankLines) — Match opens that line's reconcile there.
 */
export function salaryBankLink(p: SalaryLinkFacts, line: BankLineRef | undefined, waitingAccountId?: string): SalaryBankLink {
  const key = salaryPayState(p).key;
  if (key !== "paid" && key !== "partial") return { kind: "none" };
  if (line) return { kind: "open", href: bankLineHref(line) };
  if (key === "partial") return { kind: "none" };
  return {
    kind: "not_matched",
    matchHref: waitingAccountId ? `/accounting/banking/${waitingAccountId}?match=${salaryBankLineKey(p.net)}` : "/accounting/banking",
  };
}

/** Salaries that need a bank-line lookup: anything with money recorded against it. */
export const salariesNeedingBankLine = <T extends SalaryLinkFacts>(rows: readonly T[]): T[] =>
  rows.filter((p) => { const k = salaryPayState(p).key; return k === "paid" || k === "partial"; });
