/**
 * R-2400 — the running "Balance" after each bank line (like the bank statement's own column).
 *
 * ONE formula for the account's balance: `bankBalanceOf` = opening balance + Σ(credit − debit)
 * over every line. The bank account page's "Balance in bank" uses it, and the running balance
 * below is the same sum taken line by line, so the newest line's balance IS "Balance in bank".
 * (The opening is used as the page always has: lines are not cut at the opening date.)
 *
 * ─── ORDER ──────────────────────────────────────────────────────────────────
 * Date order (oldest first). Inside one day, statement order — but bank_transactions has no
 * line-number column, and one import inserts every line with the same created_at; ids are
 * random uuids. What the data DOES carry is the bank's own running balance (balance_after),
 * so a day is threaded by that chain — each line follows the one whose balance it starts
 * from (as lib/banking/statement-check does): first from the previous line's statement
 * balance, else from the day's one line nobody ends on. When a day cannot be threaded
 * completely (a line without balance_after, a broken chain) it falls back to created_at,
 * then id — the same id tie-break the list used before.
 *
 * ─── SCOPE ──────────────────────────────────────────────────────────────────
 * Always computed over ALL lines of the account: a filtered, searched or paged view looks
 * each row up here, so it shows that row's true balance, never a balance of only the rows
 * on screen.
 */
import { rupee } from "@/lib/utils";

export type RunningLine = {
  id: string;
  txn_date: string;
  debit: number;
  credit: number;
  balance_after: number | null;
  created_at?: string | null;
};

export type RunningBalance = {
  /** Balance after this line (opening + every credit − debit up to and including it). */
  balance: number;
  /** Position in date (statement) order, 0 = oldest — the list's same-day tie-break. */
  seq: number;
  /** The bank's own balance_after, only when it differs from `balance` by more than ₹1. */
  statementSays: number | null;
};

/** More than this (whole rupees) apart = the statement disagrees; statements carry paise. */
export const STATEMENT_TOLERANCE = 1;
const close = (a: number, b: number) => Math.abs(a - b) <= STATEMENT_TOLERANCE;
const net = (l: Pick<RunningLine, "debit" | "credit">) => (l.credit ?? 0) - (l.debit ?? 0);

/** The account's balance: opening + every line. The page's "Balance in bank". */
export function bankBalanceOf(lines: readonly Pick<RunningLine, "debit" | "credit">[], openingBalance: number | null | undefined): number {
  return (openingBalance ?? 0) + lines.reduce((s, l) => s + net(l), 0);
}

const startOf = (l: RunningLine) => (l.balance_after as number) - net(l);

function byCreatedThenId(a: RunningLine, b: RunningLine): number {
  const ca = a.created_at ?? "";
  const cb = b.created_at ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The day's lines threaded by the statement's chain from `start`; null unless every line joins. */
function thread(start: number, lines: readonly RunningLine[]): RunningLine[] | null {
  const rest = [...lines];
  const out: RunningLine[] = [];
  let cur = start;
  while (rest.length > 0) {
    const i = rest.findIndex((l) => close(startOf(l), cur));
    if (i < 0) return null;
    const [l] = rest.splice(i, 1);
    out.push(l);
    cur = l.balance_after as number;
  }
  return out;
}

/** One day's lines in statement order (see ORDER above). */
function orderDay(lines: RunningLine[], prevStatementBal: number | null): RunningLine[] {
  const base = [...lines].sort(byCreatedThenId);
  if (base.length < 2 || base.some((l) => l.balance_after === null)) return base;
  if (prevStatementBal !== null) {
    const chained = thread(prevStatementBal, base);
    if (chained) return chained;
  }
  const starts = base.filter((l) => !base.some((o) => o !== l && close(o.balance_after as number, startOf(l))));
  if (starts.length === 1) {
    const chained = thread(startOf(starts[0]), base);
    if (chained) return chained;
  }
  return base;
}

/** Every line in date order, oldest first, same day in statement order. */
export function ledgerOrder<T extends RunningLine>(lines: readonly T[]): T[] {
  const byDay = new Map<string, T[]>();
  for (const l of lines) {
    const d = byDay.get(l.txn_date);
    if (d) d.push(l); else byDay.set(l.txn_date, [l]);
  }
  const out: T[] = [];
  let prevBal: number | null = null;
  for (const day of [...byDay.keys()].sort()) {
    const ordered = orderDay(byDay.get(day)!, prevBal) as T[];
    out.push(...ordered);
    const last = ordered[ordered.length - 1];
    prevBal = last.balance_after ?? null;
  }
  return out;
}

/**
 * The balance after each line, keyed by line id — over ALL the lines given (pass the whole
 * account, not a filtered list). The newest line's balance equals bankBalanceOf(lines, opening).
 */
export function runningBalances(lines: readonly RunningLine[], openingBalance: number | null | undefined): Map<string, RunningBalance> {
  const out = new Map<string, RunningBalance>();
  let bal = openingBalance ?? 0;
  ledgerOrder(lines).forEach((l, seq) => {
    bal += net(l);
    const said = l.balance_after;
    out.set(l.id, { balance: bal, seq, statementSays: said !== null && !close(said, bal) ? said : null });
  });
  return out;
}

/** A balance as the bank prints it: −₹60,501 for an overdrawn (OD) account, Indian grouping. */
export function balanceText(n: number): string {
  return n < 0 && rupee(n) !== rupee(0) ? `−${rupee(-n)}` : rupee(n);
}
