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
  | { kind: "not_matched"; matchHref: string; /** R-2894: set when SEVERAL unlinked lines carry this net — the user picks. */ choices?: WaitingBankLine[] }
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

/** R-2894: an unlinked money-out bank line that could be this salary's payment. */
export type WaitingBankLine = {
  id: string; bank_account_id: string; txn_date: string; description: string | null; debit: number;
};

/** Opens exactly this line's Reconcile sheet (bank page ?focus=), never "the first line of this amount". */
export const bankLineFocusHref = (l: Pick<WaitingBankLine, "id" | "bank_account_id">) =>
  `/accounting/banking/${l.bank_account_id}?focus=${l.id}`;

type RawWaitingLine = WaitingBankLine & { tenant_id?: string | null; matched_to_type?: string | null };

/**
 * R-2894: every unlinked debit, grouped by whole-rupee amount (was: ONE account id per amount, so
 * the second same-amount line — the other month's — could never be offered). Same tenant only, never a
 * line that is already matched or is some salary's reconciled line (`linkedIds`), each line once.
 * Oldest first inside an amount; candidateBankLines() puts the nearest to a salary first.
 */
export function groupWaitingBankLines(
  rows: readonly RawWaitingLine[], tenantId: string, linkedIds: ReadonlySet<string>,
): Map<number, WaitingBankLine[]> {
  const seen = new Set<string>();
  const out = new Map<number, WaitingBankLine[]>();
  const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
  for (const r of sorted) {
    if (r.tenant_id !== tenantId || r.matched_to_type || linkedIds.has(r.id) || !(r.debit > 0) || seen.has(r.id)) continue;
    seen.add(r.id);
    const k = salaryBankLineKey(r.debit);
    const list = out.get(k) ?? [];
    list.push({ id: r.id, bank_account_id: r.bank_account_id, txn_date: r.txn_date, description: r.description ?? null, debit: r.debit });
    out.set(k, list);
  }
  return out;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/** The date a salary is compared with: its pay date, else the last day of its month. */
export function salaryRefDate(p: { period: string; pay_date?: string | null }): string {
  if (p.pay_date) return p.pay_date.slice(0, 10);
  const [y, m] = p.period.split("-").map(Number);
  return `${p.period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** Nearest to `refDate` first; equal distance → the earlier line. A new array. */
export function candidateBankLines(lines: readonly WaitingBankLine[] | undefined, refDate: string): WaitingBankLine[] {
  const ref = dayNumber(refDate);
  return [...(lines ?? [])].sort((a, b) =>
    Math.abs(dayNumber(a.txn_date) - ref) - Math.abs(dayNumber(b.txn_date) - ref)
    || a.txn_date.localeCompare(b.txn_date) || a.id.localeCompare(b.id));
}

/** R-2894: the lines of this salary's net, nearest its pay date first (period unknown → oldest first). */
export function salaryCandidates(
  waiting: ReadonlyMap<number, WaitingBankLine[]> | undefined,
  p: { net: number; period?: string; pay_date?: string | null },
): WaitingBankLine[] {
  const lines = waiting?.get(salaryBankLineKey(p.net));
  return p.period ? candidateBankLines(lines, salaryRefDate({ period: p.period, pay_date: p.pay_date })) : [...(lines ?? [])];
}

/**
 * @param candidates  the unlinked money-out lines of exactly this net, nearest the salary first
 *                    (candidateBankLines). One → Match opens that line; several → `choices`, the
 *                    user picks which line paid this month.
 */
export function salaryBankLink(p: SalaryLinkFacts, line: BankLineRef | undefined, candidates: readonly WaitingBankLine[] = []): SalaryBankLink {
  const key = salaryPayState(p).key;
  if (key !== "paid" && key !== "partial") return { kind: "none" };
  if (line) return { kind: "open", href: bankLineHref(line) };
  if (key === "partial") return { kind: "none" };
  if (candidates.length === 0) return { kind: "not_matched", matchHref: "/accounting/banking" };
  return {
    kind: "not_matched",
    matchHref: bankLineFocusHref(candidates[0]),
    ...(candidates.length > 1 ? { choices: [...candidates] } : {}),
  };
}

/** Salaries that need a bank-line lookup: anything with money recorded against it. */
export const salariesNeedingBankLine = <T extends SalaryLinkFacts>(rows: readonly T[]): T[] =>
  rows.filter((p) => { const k = salaryPayState(p).key; return k === "paid" || k === "partial"; });
