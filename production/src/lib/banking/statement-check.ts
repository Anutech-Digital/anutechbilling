/**
 * Does the account's computed "Balance in bank" agree with what the bank statement
 * itself says — and if not, why?
 *
 * Every imported line carries the bank's running balance (balance_after). The app's
 * figure is opening_balance + Σ(credit − debit). The two disagree for exactly two
 * reasons, and this names both, with amounts:
 *   1. the opening balance is not the balance before the first imported line;
 *   2. lines are missing between two dates — the running balance jumps by more than
 *      the lines in between explain.
 * What is left is paise rounding (R-1829): amounts are kept in whole rupees, statements
 * carry paise, so over many lines Σ(rounded) ends a few rupees from the bank's balance.
 * That is reported as verdict "rounding", never as missing lines.
 *
 * ─── ORDER WITHIN A DAY IS NOT TRUSTED ──────────────────────────────────────
 * Lines of one day may be stored in any order. Each day is re-threaded by the chain
 * itself (a line follows the one whose balance it starts from), so four salaries paid
 * on one date never read as a gap. Only day totals are compared across days, and a
 * gap is reported between two dates — never pinned to a line it cannot be sure of.
 */

export type StatementLine = {
  txn_date: string;
  debit: number;
  credit: number;
  balance_after: number | null;
};

export type StatementGap = {
  /** Last date the statement agreed with the lines (exclusive). */
  after: string;
  /** Date by which the difference shows (inclusive). */
  by: string;
  /** Positive = money OUT missing from the app; negative = money IN missing. */
  amount: number;
};

export type StatementCheck = {
  statementBalance: number;
  statementDate: string;
  appBalance: number;
  /** app − statement */
  difference: number;
  /** The balance just before the first imported line, per the statement. */
  impliedOpening: number;
  firstLineDate: string;
  /** How far the account's opening balance is from impliedOpening (account − implied). */
  openingDifference: number;
  gaps: StatementGap[];
  /** Lines compared (dated up to statementDate). */
  lineCount: number;
  /** The part of `difference` neither the opening nor a gap explains: whole-rupee rounding
      of paise amounts. openingDifference (when over ₹1) + Σ gaps + roundingDrift = difference. */
  roundingDrift: number;
  /** The most rounding alone can add up to over lineCount lines (see roundingAllowance). */
  roundingAllowance: number;
  /** match: within ₹1. rounding: only paise rounding, nothing missing. off: opening or lines. */
  verdict: "match" | "rounding" | "off";
};

const TOLERANCE = 1;   // whole rupees; statements carry paise
const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
/**
 * The most whole-rupee rounding can move a balance over `n` lines (R-1829). Each stored
 * amount is the bank's paise amount rounded (off by ≤ ₹0.50), and the two running balances
 * it is compared between are rounded too (≤ ₹0.50 each): ≤ 0.5·n + 1, in whole rupees.
 * A real bank statement of 1,449 lines ended ₹3 apart this way — not a missing line.
 */
export const roundingAllowance = (n: number) => Math.floor(n / 2) + 1;
const startOf = (l: StatementLine) => (l.balance_after as number) + l.debit - l.credit;

/**
 * The day's lines in chain order starting from `start`, as far as the chain goes.
 * Returns the ordered part and whatever could not be threaded.
 */
function thread(start: number, lines: StatementLine[]): { chained: StatementLine[]; rest: StatementLine[] } {
  const rest = [...lines];
  const chained: StatementLine[] = [];
  let cur = start;
  for (;;) {
    const i = rest.findIndex((l) => close(startOf(l), cur));
    if (i < 0) break;
    const [l] = rest.splice(i, 1);
    chained.push(l);
    cur = l.balance_after as number;
  }
  return { chained, rest };
}

/** A day's own closing balance: the line no other line of that day continues from. */
function dayEnd(lines: StatementLine[]): number {
  const ends = lines.filter((l) => !lines.some((o) => o !== l && close(startOf(o), l.balance_after as number)));
  return (ends.length === 1 ? ends[0] : lines[lines.length - 1]).balance_after as number;
}

/** A day's own opening balance: the start no other line of that day ends on. */
function dayStart(lines: StatementLine[]): number {
  const starts = lines.filter((l) => !lines.some((o) => o !== l && close(o.balance_after as number, startOf(l))));
  return startOf(starts.length === 1 ? starts[0] : lines[0]);
}

export function checkStatement(lines: StatementLine[], openingBalance: number): StatementCheck | null {
  /* Without the bank's own running balance there is nothing to check against — say
     nothing rather than something made up. Lines WITHOUT a balance (typed by hand, or
     read from a PDF that did not show one) still count: their amounts are part of the
     day's movement; they just cannot anchor the chain. Hiding the whole check because
     one line lacks a balance is how a wrong opening balance went unflagged. */
  const withBal = lines.filter((l) => l.balance_after !== null);
  if (withBal.length === 0) return null;

  const byDay = new Map<string, StatementLine[]>();
  for (const l of lines) byDay.set(l.txn_date, [...(byDay.get(l.txn_date) ?? []), l]);
  const days = [...byDay.keys()].sort();
  const balOf = (d: string) => byDay.get(d)!.filter((l) => l.balance_after !== null);
  const netOf = (ls: StatementLine[]) => ls.reduce((s, l) => s + l.credit - l.debit, 0);

  /* Opening: the first day that has a balance, walked back over any earlier days. */
  const firstBalDay = days.find((d) => balOf(d).length > 0)!;
  const beforeFirst = days.filter((d) => d < firstBalDay).flatMap((d) => byDay.get(d)!);
  const impliedOpening = dayStart(balOf(firstBalDay)) - netOf(beforeFirst);

  /* Compared at the last date the statement states a balance; lines after it are not
     checked (nothing to check them against), so they are left out of both sides. */
  const lastBalDay = [...days].reverse().find((d) => balOf(d).length > 0)!;
  const appBalance = openingBalance + netOf(lines.filter((l) => l.txn_date <= lastBalDay));

  const gaps: StatementGap[] = [];
  let cur = impliedOpening;
  let lastGood = "";
  for (const d of days) {
    if (d > lastBalDay) break;
    const dayLines = byDay.get(d)!;
    const bal = balOf(d);
    const net = netOf(dayLines);
    if (bal.length === 0) {
      cur += net;   // no evidence for this day — take its lines as they are
      continue;
    }
    const threaded = bal.length === dayLines.length ? thread(cur, dayLines) : null;
    if (threaded && threaded.rest.length === 0) {
      /* Carry the bank's own figure forward, not cur + net. Amounts are whole rupees and
         statements carry paise, so Σ(rounded amounts) drifts from the running balance —
         ₹24 over 60 lines of ₹10.40 — and that drift read as "lines missing" (R-1693). */
      cur = threaded.chained[threaded.chained.length - 1].balance_after as number;
      lastGood = d;
      continue;
    }
    /* The chain broke, or the day has lines with no balance to thread: compare the day's
       total movement with the statement's closing figure for that day. */
    const end = dayEnd(bal);
    const expected = cur + net;
    if (!close(expected, end)) gaps.push({ after: lastGood || d, by: d, amount: expected - end });
    cur = end;
    lastGood = d;
  }

  /* When lines are missing INSIDE a day, that day's true closing balance is unknowable,
     so the shortfall can show as −X on one date and +Y on the next. Adjacent gaps of
     opposite sign are one hole seen twice: report them as one window with their sum. */
  const merged: StatementGap[] = [];
  for (const g of gaps) {
    const prev = merged[merged.length - 1];
    if (prev && prev.by === g.after && Math.sign(prev.amount) !== Math.sign(g.amount)) {
      prev.by = g.by;
      prev.amount += g.amount;
    } else {
      merged.push({ ...g });
    }
  }
  /* A "gap" no bigger than what rounding of the lines inside it can add up to is rounding:
     a day whose lines do not thread (±₹1 each) is compared as a whole, and over many lines
     the paise add up past ₹1 without any line missing. */
  const linesIn = (g: StatementGap) => lines.filter((l) => l.txn_date >= g.after && l.txn_date <= g.by).length;
  const realGaps = merged.filter((g) => Math.abs(g.amount) > Math.max(TOLERANCE, roundingAllowance(linesIn(g))));

  const statementBalance = dayEnd(balOf(lastBalDay));
  const difference = appBalance - statementBalance;
  const openingDifference = openingBalance - impliedOpening;
  const lineCount = lines.filter((l) => l.txn_date <= lastBalDay).length;
  const allowance = roundingAllowance(lineCount);
  /* Whatever the opening and the gaps do not explain is rounding. An opening within ₹1 is
     itself rounding (the balance before the first line is worked out from rounded figures). */
  const openingOff = !close(openingDifference, 0);
  const roundingDrift = difference - realGaps.reduce((s, g) => s + g.amount, 0) - (openingOff ? openingDifference : 0);
  const verdict: StatementCheck["verdict"] = close(difference, 0)
    ? "match"
    : realGaps.length === 0 && !openingOff && Math.abs(roundingDrift) <= allowance
      ? "rounding"
      : "off";
  return {
    statementBalance,
    statementDate: lastBalDay,
    appBalance,
    difference,
    impliedOpening,
    firstLineDate: days[0],
    openingDifference,
    gaps: realGaps,
    lineCount,
    roundingDrift,
    roundingAllowance: allowance,
    verdict,
  };
}
