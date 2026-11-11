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

/** R-2657 — HDFC's GST on its own charges: "<ref> DPO<digits> CGST" / "SGST" (also IGST / UTGST). */
export const BANK_GST = /\bDPO\d{6,}\s+(?:CGST|SGST|IGST|UTGST)\b/i;
export const isBankGstLine = (description: string | null | undefined): boolean => BANK_GST.test(description ?? "");

/** What this money-out line probably is — same layers and order as the Reconcile sheet. */
export function expenseSuggestion(t: Line, rules: readonly CategoryRule[], keywordFn: KeywordFn): ExpenseSuggestion | null {
  if (!(t.debit > 0)) return null;
  /* R-2657: the bank's GST on its own charges — Bank Charges, GST ₹0 (an expense, never input GST:
     Pardeep's D1, 10 Nov — the no-vendor tool must not claim ITC; open-month ITC is R-2664).
     The company's own Category Rule for such a line still wins. */
  if (isBankGstLine(t.description) && !categoriseByRules(t, rules)) {
    return { category: "Bank Charges", reason: "the bank's GST on its charges (DPO … CGST / SGST) — booked as a bank charge, no GST claimed", confidence: "high" };
  }
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

/* ── R-2657 (independent review, 11 Nov): how far a payee Category Rule may reach in this tool ──
   Category Rules match by plain substring everywhere else (lib/banking/categorise.ts — the import,
   the Rules page and the Reconcile sheet keep that; gateway narrations have no word breaks). Here a
   rule can put a line on "High" and get it ticked in bulk, so it counts only when it is a full payee
   text that stands as whole word(s) in the narration: rule RAVI must never tick "RAVINDRA STEELS" or
   "RAVI KUMAR". The same test decides whether "Always book like this" may save a rule at all. */

/** Words that say how / through which bank money moved, or are on every statement — never a payee. */
const RULE_GENERIC = new Set([
  "UPI", "NEFT", "IMPS", "RTGS", "ACH", "ECS", "NACH", "INFT", "MMT", "TPT", "POS", "CHQ", "ATM", "ATW", "NWD", "DR", "CR",
  "HDFC", "ICICI", "ICIC", "SBI", "SBIN", "AXIS", "UTIB", "KOTAK", "KKBK", "PNB", "PUNB", "YES", "YESB", "IDFC", "PAYTM", "PYTM",
  "BANK", "BANKING", "NETBANK", "NETBANKING", "MOBILE", "ONLINE", "INTERNET",
  "PAY", "PAID", "PAYMENT", "PAYMENTS", "TRANSFER", "TRF", "REMARK", "REMARKS", "CHARGE", "CHARGES", "BILL", "BILLS", "FEE", "FEES",
  "CASH", "SELF", "WITHDRAWAL", "DEPOSIT", "SALARY", "LOAN", "EMI", "TAX", "GST", "CGST", "SGST", "IGST", "TDS", "CHALLAN",
  "EXP", "EXPENSE", "EXPENSES", "FOR", "THE", "AND", "TO", "FROM", "BY", "OF",
  "INDIA", "PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "CO", "COMPANY",
]);

const up = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * May this text be a payee rule that ticks lines in bulk / be saved by "Always book like this"?
 * Two or more real words, or ONE real word of 6+ characters (6+ in all either way) — a text
 * with a rail, bank or generic word in it is never such a rule.
 */
export function isSafeRuleKey(pattern: string | null | undefined): boolean {
  const words = up(pattern).split(/[^A-Z0-9]+/).filter(Boolean);
  if (words.length === 0 || words.some((w) => RULE_GENERIC.has(w))) return false;
  /* Every word needs a letter (a bare number is a reference, not a payee); a merchant code such as
     "ZQXR2611" counts with its digits. */
  if (words.some((w) => !/[A-Z]/.test(w))) return false;
  return words.reduce((n, w) => n + w.length, 0) >= 6;
}

/** Is the rule text in the narration as whole word(s) — not inside a longer word or number? */
export function wholeWordMatch(description: string | null | undefined, pattern: string | null | undefined): boolean {
  const text = up(description);
  const p = up(pattern);
  if (!text || !p) return false;
  for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) {
    const before = i === 0 ? "" : text[i - 1];
    const after = i + p.length >= text.length ? "" : text[i + p.length];
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
  }
  return false;
}

const ATM = /\b(?:ATM|ATW|NWD|EAW)\b|\bCASH\s*(?:WDL|WITHDRAWAL|W\/D)\b|\bSELF\b/i;
/* The own-transfer words of R-2656's pair finder (bank_pair_fd_word / _card_word / _transfer_word). */
const OWN_TRANSFER = /(?:^|[^A-Z])(?:SWEEP|SWEEPIN|SWEEPOUT|FD|FDR)(?:[^A-Z]|$)|FIXED DEPOSIT|AUTO SWEEP|CREDIT CARD|CC PAYMENT|CARD PAYMENT|OWN A\/?C|OWN ACCOUNT/i;

/**
 * A line a payee rule is never saved from and never applied to: cash from an ATM, a transfer
 * between the company's own accounts, salary, a tax / GST / TDS challan, a loan / EMI.
 */
export function ruleUnsafeLine(description: string | null | undefined): boolean {
  const d = description ?? "";
  return ATM.test(d) || OWN_TRANSFER.test(d) || !!detectGovtPayment(d) || LOAN.test(d) || SALARY.test(d);
}

/** The company's rules that may count as "High" for this line (full payee text, whole words). */
const strictRules = (t: Line, rules: readonly CategoryRule[]): CategoryRule[] =>
  ruleUnsafeLine(t.description) ? [] : rules.filter((r) => isSafeRuleKey(r.pattern) && wholeWordMatch(t.description, r.pattern));

/**
 * The bulk sheet's suggestion: as expenseSuggestion, but a Category Rule is "High" only through a
 * strict rule (above). A rule that matches only loosely still shows its category — medium, never
 * ticked for the owner — and no rule at all is applied to an ATM / own-transfer / salary / challan /
 * loan line.
 */
export function bulkSuggestion(t: Line, rules: readonly CategoryRule[], keywordFn: KeywordFn): ExpenseSuggestion | null {
  if (ruleUnsafeLine(t.description)) return expenseSuggestion(t, [], keywordFn);
  const strict = strictRules(t, rules);
  if (categoriseByRules(t, strict)) return expenseSuggestion(t, strict, keywordFn);
  const loose = expenseSuggestion(t, rules, keywordFn);
  const hit = categoriseByRules(t, rules);
  if (loose && hit && loose.reason === hit.reason && loose.confidence === "high") {
    return { ...loose, confidence: "medium", reason: `${loose.reason} — the rule text is short or only part of a longer name here; check before you tick` };
  }
  return loose;
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
    const s = bulkSuggestion(t, rules, keywordFn);
    out.push({
      id: t.id, txn_date: t.txn_date, description: t.description, debit: t.debit,
      category: s?.category ?? "", payee: suggestedPayee(t, strictRules(t, rules), knownNames),
      reason: s?.reason ?? null, confidence: s?.confidence ?? null,
      autoTick: s?.confidence === "high" && t.debit < AUTO_TICK_MAX,
    });
  }
  return out;
}
