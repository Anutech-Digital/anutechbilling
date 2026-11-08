/**
 * R-2611 — Banking → "Money out · no vendor yet" in bulk (pure part).
 *
 * Pardeep (8 Nov): HDFC 4523 had 832 money-out lines with no vendor; each was opened and booked
 * one by one. Here every such line gets the SAME suggestion the Reconcile sheet's "Book as
 * expense" pre-fills (moved here from reconcile-transaction-dialog.tsx so both read one place):
 * the category from the import / Category Rules / built-in keywords, and the payee from the rule
 * or the narration. The owner ticks rows and books them at once; each row is booked by the
 * existing book_bank_txn_as_expense (no new money rule, R-1917's open-bill guard included).
 *
 * Confidence: high = the tenant's own Category Rule or a ₹1–₹10 test
 * transfer; medium = the import's category, a built-in keyword or a "director" narration (a word, not a rule). "Tick all high-confidence"
 * never ticks a line of ₹1,00,000 or more (AUTO_TICK_MAX) — the owner ticks those by hand.
 * Government challans, loans / EMIs, salary advances are never offered: they have their own tiles.
 */
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { categoriseByRules, suggestForLine, type CategoryRule } from "./categorise";
import { detectGovtPayment } from "./govt-payment";
import { payeeFromNarration, TEST_TRANSFER_MAX } from "./narration";
import { titleCaseName } from "./salary-lines";

export const BULK_MAX = 100;
export const AUTO_TICK_MAX = 100_000;

export type Confidence = "high" | "medium";
export interface ExpenseSuggestion { category: string; reason: string; confidence: Confidence }

interface Line { description: string | null; debit: number; credit: number; category?: string | null }
type KeywordFn = (text: string) => string | null;

/** An expense category the bulk / sheet may book — never Salaries (Payroll's). */
export const isBookableCategory = (c: string | null | undefined): c is string =>
  !!c && c !== "Salaries" && (EXPENSE_CATEGORIES as readonly string[]).includes(c);

/** What this money-out line probably is — same layers and order as the Reconcile sheet. */
export function expenseSuggestion(t: Line, rules: readonly CategoryRule[], keywordFn: KeywordFn): ExpenseSuggestion | null {
  if (!(t.debit > 0)) return null;
  /* "SALARY TO DIRECTOR": booked as an expense, this is Director's Remuneration —
     never plain Salaries (which belongs to Payroll) and never a guessed category. */
  if (/\bDIRECTORS?\b/i.test(t.description ?? "")) {
    return { category: "Director's Remuneration", reason: "the word \"director\" in the narration", confidence: "medium" };
  }
  if (isBookableCategory(t.category)) return { category: t.category, reason: "set when the statement was imported", confidence: "medium" };
  const s = suggestForLine(t, rules, keywordFn);
  if (s && isBookableCategory(s.category)) {
    return { category: s.category, reason: s.reason, confidence: s.layer === "tenant-rule" ? "high" : "medium" };
  }
  /* Last layer: a ₹1–₹10 debit with nothing else to say about it is a test /
     account-verification ("penny drop") transfer — booked as a bank charge. */
  if (t.debit <= TEST_TRANSFER_MAX) {
    return { category: "Bank Charges", reason: `a ₹${t.debit} debit — usually a test / account-verification transfer`, confidence: "high" };
  }
  return null;
}

/** Who was paid: the Category Rule's name (an existing advance vendor's spelling wins), else the narration's payee. */
export function suggestedPayee(t: Line, rules: readonly CategoryRule[], knownNames: readonly string[] = []): string {
  if (!(t.debit > 0)) return "";
  const pattern = categoriseByRules(t, rules)?.rule.pattern.trim() ?? "";
  if (!pattern) return payeeFromNarration(t.description) ?? "";
  const key = pattern.toUpperCase().slice(0, 5);
  return knownNames.find((v) => v.toUpperCase().startsWith(key)) ?? titleCaseName(pattern);
}

const LOAN = /\bLOANS?\b|\bEMI\b|\bREPAYMENT\b/i;
const SALARY = /\bSALARY\b|\bSAL ADV\b|\bSTAFF ADVANCE\b/i;

/** Why a line is never booked as an expense in bulk — null when it may be. */
export function bulkExcluded(t: { description: string | null; debit: number }): string | null {
  if (!(t.debit > 0)) return "Only a money-out line can be booked as an expense.";
  const govt = detectGovtPayment(t.description);
  if (govt) return `${govt.label} — book it from the line's Government tile.`;
  if (LOAN.test(t.description ?? "")) return "Looks like a loan / EMI — book it from the line's Loan tile.";
  if (SALARY.test(t.description ?? "") && !/\bDIRECTORS?\b/i.test(t.description ?? "")) {
    return "Looks like salary or a salary advance — book it from Salary lines.";
  }
  return null;
}

/** Server check per row: the category and the line itself. */
export function refuseBulkRow(t: { description: string | null; debit: number }, category: string): string | null {
  if (category === "Salaries") return "Salaries are booked through Payroll, not as an expense.";
  if (!isBookableCategory(category)) return "Choose an expense category from the list.";
  return bulkExcluded(t);
}

export interface BulkRow {
  id: string;
  txn_date: string;
  description: string | null;
  debit: number;
  /** "" = nothing suggested — the owner picks one before ticking. */
  category: string;
  payee: string;
  reason: string | null;
  confidence: Confidence | null;
  /** Ticked by "Tick all high-confidence". */
  autoTick: boolean;
}

/** The bulk list: every offered line with its suggestion (input order kept). */
export function bulkRows<T extends Line & { id: string; txn_date: string }>(
  lines: readonly T[], rules: readonly CategoryRule[], keywordFn: KeywordFn, knownNames: readonly string[] = [],
): BulkRow[] {
  const out: BulkRow[] = [];
  for (const t of lines) {
    if (bulkExcluded(t)) continue;
    const s = expenseSuggestion(t, rules, keywordFn);
    out.push({
      id: t.id, txn_date: t.txn_date, description: t.description, debit: t.debit,
      category: s?.category ?? "", payee: suggestedPayee(t, rules, knownNames),
      reason: s?.reason ?? null, confidence: s?.confidence ?? null,
      autoTick: s?.confidence === "high" && t.debit < AUTO_TICK_MAX,
    });
  }
  return out;
}
