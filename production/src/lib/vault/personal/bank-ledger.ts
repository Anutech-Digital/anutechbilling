/**
 * R-2394 — Private Vault → Banking account page, the pure part: direction of a line, the
 * running balance, filters, the statement check (like a BRS) and which entries a statement
 * line can be matched to. No DB, no UI, no company books.
 *
 * The balance is the one personal_account_balances computes (GP-12a):
 *   bank / cash / deposit:  opening + money in − money out
 *   credit card:            amount OWED = opening + money out − money in
 * `sign` below is the same CASE the view uses, so the running balance on the page always ends
 * on the same figure as the Assets list and the Overview.
 */
import type { CategoryRule } from "@/lib/banking/categorise";
import type { PersonalImportLine as MappedLine } from "./import";
import { PERSONAL_INCOME_CATEGORIES } from "./categories";
import { ACCOUNT_KIND_LABEL, type AccountKind } from "./net-worth";

export const IN_KINDS: ReadonlySet<string> = new Set([
  "drawing", "dividend", "salary", "interest", "other_income", "transfer_in", "refund",
]);

/** +1 = money into this account, −1 = money out (card_payment is IN on a credit card). */
export function txSign(kind: string, accountKind: string): 1 | -1 {
  if (IN_KINDS.has(kind)) return 1;
  if (kind === "card_payment" && accountKind === "credit_card") return 1;
  return -1;
}

export interface LedgerTx {
  id: string;
  account_id: string | null;
  kind: string;
  amount: number;
  occurred_on: string;
  created_at: string;
  category: string | null;
  note: string | null;
  party: string | null;
  income_source: string | null;
  source: string;
  raw_description: string | null;
  reference: string | null;
  balance_after: number | null;
  dedupe_hash: string | null;
  reconciled_at?: string | null;
  line_no?: number | null;
  pair_tx_id?: string | null;
  owe_hold_id?: string | null;
}

export type MatchStatus = "unmatched" | "matched" | "entry";

/** unmatched = an imported line nobody has explained yet; matched = explained; entry = typed by you. */
export function matchStatus(t: Pick<LedgerTx, "source" | "reconciled_at">): MatchStatus {
  if (t.source !== "import") return "entry";
  return t.reconciled_at ? "matched" : "unmatched";
}

export interface LedgerRow<T extends LedgerTx = LedgerTx> {
  tx: T;
  sign: 1 | -1;
  moneyIn: number;
  moneyOut: number;
  /** Balance after this line (for a card: amount owed after it). */
  running: number;
  status: MatchStatus;
}

/** Date, then when it was saved, then the line's place in its statement file. */
export function compareTx(a: LedgerTx, b: LedgerTx): number {
  if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? -1 : 1;
  const an = a.line_no ?? null;
  const bn = b.line_no ?? null;
  // Two lines of the same statement keep the bank's order, whenever they were saved.
  if (an !== null && bn !== null && a.created_at === b.created_at) return an - bn;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (an !== null && bn !== null) return an - bn;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Oldest first, each with the balance after it. */
export function buildLedger<T extends LedgerTx>(
  account: { kind: string; opening_balance: number },
  txns: readonly T[],
): LedgerRow<T>[] {
  const card = account.kind === "credit_card";
  let running = account.opening_balance;
  return [...txns].sort(compareTx).map((tx) => {
    const sign = txSign(tx.kind, account.kind);
    running += card ? -sign * tx.amount : sign * tx.amount;
    return {
      tx, sign, running,
      moneyIn: sign === 1 ? tx.amount : 0,
      moneyOut: sign === -1 ? tx.amount : 0,
      status: matchStatus(tx),
    };
  });
}

export interface LedgerFilter {
  status: "all" | MatchStatus;
  direction: "all" | "in" | "out";
  /** YYYY-MM or null for every month. */
  month: string | null;
  query: string;
}

export const ALL_LINES: LedgerFilter = { status: "all", direction: "all", month: null, query: "" };

function searchable(r: LedgerRow): string {
  const t = r.tx;
  return [t.raw_description, t.note, t.category, t.party, t.reference, String(t.amount)]
    .filter(Boolean).join(" ").toLowerCase();
}

export function filterLedger<T extends LedgerTx>(rows: readonly LedgerRow<T>[], f: LedgerFilter): LedgerRow<T>[] {
  const q = f.query.trim().toLowerCase().replace(/[₹,]/g, "");
  return rows.filter((r) =>
    (f.status === "all" || r.status === f.status)
    && (f.direction === "all" || (f.direction === "in" ? r.sign === 1 : r.sign === -1))
    && (!f.month || r.tx.occurred_on.startsWith(f.month))
    && (!q || searchable(r).replace(/,/g, "").includes(q)));
}

/** Months that have lines, newest first (for the month filter). */
export function ledgerMonths(rows: readonly LedgerRow[]): string[] {
  return [...new Set(rows.map((r) => r.tx.occurred_on.slice(0, 7)))].sort().reverse();
}

export interface LedgerTotals { moneyIn: number; moneyOut: number; unmatched: number; balance: number }

export function ledgerTotals(account: { opening_balance: number }, rows: readonly LedgerRow[]): LedgerTotals {
  return {
    moneyIn: rows.reduce((s, r) => s + r.moneyIn, 0),
    moneyOut: rows.reduce((s, r) => s + r.moneyOut, 0),
    unmatched: rows.filter((r) => r.status === "unmatched").length,
    balance: rows.length ? rows[rows.length - 1].running : account.opening_balance,
  };
}

// ─── statement check (like a BRS) ────────────────────────────────────────────

export interface StatementBalanceCheck {
  /** The balance the bank printed on the last imported line that has one. */
  statementBalance: number;
  statementDate: string;
  /** Our balance at that same line. */
  appBalance: number;
  /** app − statement. 0 = matches. */
  difference: number;
  /** Lines saved after that line (dated later) — not part of the comparison. */
  laterLines: number;
  matches: boolean;
}

/**
 * Does our balance agree with the bank's? Compared at the LAST imported line that carries the
 * bank's running balance. null = nothing imported with a balance yet — say nothing.
 */
export function checkAgainstStatement(rows: readonly LedgerRow[]): StatementBalanceCheck | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.tx.source === "import" && r.tx.balance_after !== null && r.tx.balance_after !== undefined) {
      const difference = r.running - r.tx.balance_after;
      return {
        statementBalance: r.tx.balance_after,
        statementDate: r.tx.occurred_on,
        appBalance: r.running,
        difference,
        laterLines: rows.length - 1 - i,
        matches: Math.abs(difference) <= 1,
      };
    }
  }
  return null;
}

/** One plain sentence for the check. */
export function statementCheckText(c: StatementBalanceCheck): string {
  if (c.matches) return "Matches the statement.";
  const amt = Math.abs(c.difference).toLocaleString("en-IN");
  return c.difference > 0
    ? `₹${amt} more here than on the statement. Check for money in counted twice, a money-out line missing here, or a wrong opening balance.`
    : `₹${amt} less here than on the statement. Check for an entry counted twice (match it with "Already entered"), a money-in line missing here, or a wrong opening balance.`;
}

// ─── what a line can be matched to ───────────────────────────────────────────

export type ReconcileAction =
  | "expense" | "income" | "drawing" | "card_payment" | "atm_cash"
  | "transfer" | "loan" | "owe_hold" | "match";

export const ACTION_LABEL: Record<ReconcileAction, string> = {
  expense: "Expense",
  income: "Income",
  drawing: "Drawing from company",
  card_payment: "Card payment",
  atm_cash: "ATM cash",
  transfer: "Transfer between my accounts",
  loan: "Loan EMI / repayment",
  owe_hold: "Byana / held money",
  match: "Already entered",
};

/** The choices that make sense for a line going this way on this kind of account. */
export function actionsFor(sign: 1 | -1, accountKind: string): ReconcileAction[] {
  const card = accountKind === "credit_card";
  if (sign === -1) {
    return card
      ? ["expense", "loan", "owe_hold", "match"]
      : ["expense", "card_payment", "atm_cash", "transfer", "loan", "owe_hold", "match"];
  }
  return card
    ? ["card_payment", "income", "match"]
    : ["income", "drawing", "transfer", "loan", "owe_hold", "match"];
}

/** The sheet's first choice: what the importer guessed from the narration. */
export function suggestedAction(t: Pick<LedgerTx, "kind">, sign: 1 | -1, accountKind: string): ReconcileAction {
  const allowed = actionsFor(sign, accountKind);
  const guess: ReconcileAction | null =
    t.kind === "expense" ? "expense"
    : t.kind === "card_payment" ? "card_payment"
    : t.kind === "atm_cash" ? "atm_cash"
    : t.kind === "transfer_in" || t.kind === "transfer_out" ? "transfer"
    : t.kind === "drawing" ? "drawing"
    : IN_KINDS.has(t.kind) ? "income"
    : null;
  return guess && allowed.includes(guess) ? guess : allowed[0];
}

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/**
 * Entries you typed elsewhere (Loans, Income & Expenses) that this bank line may BE: same
 * amount, same direction, on this account or on no account, within 10 days, not yet tied to
 * a statement line. Nearest date first.
 */
export function matchCandidates<T extends LedgerTx>(
  line: LedgerTx,
  accountKind: string,
  entries: readonly T[],
): T[] {
  const sign = txSign(line.kind, accountKind);
  return entries
    .filter((e) => e.id !== line.id
      && e.source === "manual" && !e.dedupe_hash
      && (e.account_id === null || e.account_id === line.account_id)
      && e.amount === line.amount
      && txSign(e.kind, accountKind) === sign
      && daysApart(e.occurred_on, line.occurred_on) <= 10)
    .sort((a, b) => daysApart(a.occurred_on, line.occurred_on) - daysApart(b.occurred_on, line.occurred_on));
}

/** The other account's lines that can be this transfer's other leg (same amount, the other way, ≤ 5 days). */
export function transferCandidates<T extends LedgerTx>(
  line: LedgerTx,
  lineSign: 1 | -1,
  otherAccountKind: string,
  otherLines: readonly T[],
): T[] {
  return otherLines
    .filter((o) => o.amount === line.amount
      && !o.pair_tx_id
      && !(o.source === "import" && o.reconciled_at)
      && txSign(o.kind, otherAccountKind) === -lineSign
      && daysApart(o.occurred_on, line.occurred_on) <= 5)
    .sort((a, b) => daysApart(a.occurred_on, line.occurred_on) - daysApart(b.occurred_on, line.occurred_on));
}

// ─── import: mapped statement line → personal_transactions row ───────────────

const INCOME_KIND_BY_CATEGORY: Record<string, string> = {
  Salary: "salary", Interest: "interest", Dividend: "dividend",
};

/** The DB kind (and category) a mapped statement line is saved with. The owner confirms it later. */
export function dbKindFor(line: Pick<MappedLine, "kind" | "category" | "reason">): { kind: string; category: string | null } {
  switch (line.kind) {
    case "income":
      return { kind: INCOME_KIND_BY_CATEGORY[line.category ?? ""] ?? "other_income", category: line.category };
    case "transfer_out":
      return line.reason === "ATM cash" ? { kind: "atm_cash", category: null } : { kind: "transfer_out", category: null };
    default:
      return { kind: line.kind, category: line.category };
  }
}

/**
 * The person's rules (personal_category_rules) in the company matcher's shape. A personal
 * rule has no direction of its own: an income category fires only on money IN, anything else
 * only on money OUT (a SWIGGY refund must not become Food spending).
 */
export function toCategoryRules(rows: readonly { id: string; match_text: string; category: string }[]): CategoryRule[] {
  const income = new Set<string>(PERSONAL_INCOME_CATEGORIES);
  return rows.map((r) => ({
    id: r.id,
    pattern: r.match_text,
    category: r.category,
    direction: income.has(r.category) ? "credit" : "debit",
  }) as CategoryRule);
}

/** A short word or brand from the narration to offer as the rule text ("UPI-SWIGGY-…" → "SWIGGY"). */
export function ruleTextFrom(description: string | null | undefined): string {
  const words = (description ?? "").toUpperCase().split(/[^A-Z0-9&.]+/).filter(Boolean);
  const skip = new Set(["UPI", "NEFT", "IMPS", "RTGS", "ACH", "NACH", "POS", "TO", "BY", "FROM", "TRANSFER", "DR", "CR", "PAYMENT", "ORDER", "REF", "TXN", "BANK", "LTD", "PVT", "THE", "SELF", "ATM", "NWD", "MB", "IB", "INB", "BIL", "BILLPAY", "ONL"]);
  return words.find((w) => w.length >= 3 && !/^\d+$/.test(w) && !skip.has(w) && !/^[A-Z]{4}0/.test(w)) ?? "";
}

export function accountKindLabel(kind: string): string {
  return ACCOUNT_KIND_LABEL[kind as AccountKind] ?? kind;
}
