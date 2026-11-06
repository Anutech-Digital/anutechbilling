/**
 * R-2497 — moving a bank account's opening balance from a statement must keep today's balance.
 *
 * The opening is the balance at the START of its date, so it already holds every earlier line.
 * When an import sets an EARLIER opening (e.g. Excel's FY 25-26 statement, 1 Apr 2025, on an
 * account opened at 1 Apr 2026), the statement's balance where it MEETS the app's existing data
 * must equal the old opening (±₹1, statements carry paise). Otherwise today's balance would
 * change: a line is missing, or the date is wrong.
 *
 * R-2522 — WHERE the statement meets the existing data (6 Nov 2026, staging HDFC 4523):
 *   the FY 25-26 statement's last line, SUBHVISION NEFT ₹37,170, is dated 01/04/26 with value
 *   date 31/03/26. HDFC counts it inside the 31 Mar 2026 closing (₹9,03,551.93) — which is the
 *   app's 1 Apr 2026 opening — and the app does not have that line yet. R-2497 only added lines
 *   dated BEFORE the old opening date, so it said −₹37,172 and refused a correct statement.
 *   The meeting point holds:
 *     • every line dated from the new date up to the day before the old date — the statement's
 *       new lines AND what the app already holds there, hand-entered lines too (after the move
 *       they are all counted; the database counts them, so the preview does: `existingInWindow`), and
 *     • the statement lines NEW to the app that belong before the old date. Two readings are
 *       tried, and the statement matches if either does: (a) only lines whose VALUE date is
 *       before the old date (`meetDate`, the earlier of the two dates) — a real 1 Apr charge is
 *       after a 31 Mar closing; (b) also every new line dated ON the old date — a file without
 *       a value-date column still meets on SUBHVISION. A line the app already has on that date
 *       is existing data, never counted. Neither matching → the closer one is shown.
 *   And the figure is the statement's OWN running balance at that point, when it has one and the
 *   summed figure differs from it only by rounding (below). The summed figure is used instead
 *   when the balance column is missing, when a new line of that last day is NOT counted (its
 *   balance would be in the figure), or when the two differ by more than rounding. The drift
 *   itself is returned (and stored in the history by the database) — it is the ₹ by which
 *   today's balance moves.
 *
 * R-2528 (review of R-2522, 6 Nov 2026) — only REAL rounding is rounding:
 *   R-2522 allowed least(floor(n/2)+1, 25) rupees, so on 48+ lines a missing ₹17.70 SMS charge
 *   passed as rounding. The drift exists because amounts are stored in whole rupees (the parser
 *   rounds them); a bank's statement is exact to the paisa. So the comparison is now in PAISE:
 *   the parser keeps each line's paise (amount_paise / balance_paise), and the bank's balance is
 *   used only when the summed paise are within MEET_PAISE_TOLERANCE (the opening's own rounding,
 *   ≤ 50 paise) of it — MEET_PAISE_TOLERANCE_UNKNOWN when a counted line's paise are not known
 *   (lines already in the app). Anything more is a difference the owner accepts with a reason.
 *   One rule with the database (migration 20261106122847_r2528): a line dated AFTER the old date
 *   counts only when its value date is BEFORE the old date (the second reading adds the lines
 *   dated ON it); the summed figure adds whole-rupee amounts line by line, as they are stored.
 *
 * The database checks the same thing on save (set_bank_opening_from_statement, on the stored
 * lines — R-2522 / R-2528 migrations) and refuses unless the owner accepts the difference; this
 * is the preview of it.
 */
import { STATEMENT_TOLERANCE, countsAfterOpening } from "./running-balance";
import { signedRound } from "./statement-parse";

/** R-2528: the opening is whole rupees read from the statement's paise — the only rounding left
    when every counted line carries its paise (the database uses the same 50). */
export const MEET_PAISE_TOLERANCE = 50;
/** R-2528: when a counted line's paise are not known (already in the app): ₹1 at most. */
export const MEET_PAISE_TOLERANCE_UNKNOWN = 100;

type Line = {
  txn_date: string;
  /** R-2522: the bank's value date, when the statement prints one. */
  value_date?: string | null;
  debit: number;
  credit: number;
  balance_after?: number | null;
  /** R-2528: the amount in paise as printed (statement-parse), when it has paise. */
  amount_paise?: number;
  /** R-2528: the running balance in paise as printed, when it has paise. */
  balance_paise?: number | null;
};

export type OpeningMoveCheck =
  /** Nothing to keep: the account has no money yet (opening 0, no lines). */
  | { kind: "none" }
  /** Same or later date: the database compares on save (it needs the stored lines). */
  | { kind: "later"; oldDate: string }
  | {
      kind: "earlier";
      oldDate: string;
      oldOpening: number;
      /** The statement's balance where it meets the existing data (the start of the old opening date). */
      balanceOnOldDate: number;
      /** balanceOnOldDate − oldOpening. */
      difference: number;
      matches: boolean;
      /** R-2522: new lines dated on/after the old opening date counted before the meeting point
          (value date earlier, or the "on the old date" reading) — the bank put them in that closing. */
      linesOnOldDate: number;
      /** R-2522: Σ(rounded amounts) − the statement's own balance, when the balance was used:
          today's balance moves by this much (paise rounding). */
      roundingDrift: number;
    };

/** R-2522: the date a line belongs to for the meeting point — its value date when that is earlier. */
export function meetDate(l: Pick<Line, "txn_date" | "value_date">): string {
  return l.value_date && l.value_date < l.txn_date ? l.value_date : l.txn_date;
}

/** R-2528: whole rupees as the database stores them (greatest(0, round(x)), half away from 0). */
const rupees = (x: number | null | undefined) => Math.max(0, signedRound(x ?? 0));

/** R-2528: a line as the meeting point reads it, in paise — the same rule as import_bank_statement
    + r2522_bank_meet_balance: a statement line's own paise when they round to its rupees, else
    rupees × 100. `exact` = a line of this import (its paise are known). */
type PLine = { txn_date: string; netR: number; netP: number; balP: number | null; exact: boolean };

function toPaise(l: Line, exact: boolean): PLine {
  const dr = rupees(l.debit), cr = rupees(l.credit);
  const netR = cr - dr;
  const amt = l.amount_paise;
  const amtOk = exact && amt != null && Number.isInteger(amt) && amt >= 0 && signedRound(amt / 100) === dr + cr;
  const netP = amtOk ? (cr > 0 ? amt : -amt) : netR * 100;
  const balR = l.balance_after == null ? null : signedRound(l.balance_after);
  const bp = l.balance_paise;
  const balOk = exact && balR !== null && bp != null && Number.isInteger(bp) && signedRound(bp / 100) === balR;
  const balP = balR === null ? null : balOk ? (bp as number) : balR * 100;
  return { txn_date: l.txn_date, netR, netP, balP, exact };
}

/** The statement's balance (paise) at the end of the counted lines' last day — the one line of
    that day no other line of the day continues from (order-free, as statement-check's dayEnd).
    null when that day has a line without a balance, no single end, or a line of that day left
    out (`uncounted` — its amount would be inside the figure). */
function statedPaise(counted: readonly PLine[], uncounted: readonly Line[]): number | null {
  if (counted.length === 0) return null;
  const lastDay = counted.reduce((m, l) => (l.txn_date > m ? l.txn_date : m), counted[0].txn_date);
  if (uncounted.some((l) => l.txn_date === lastDay)) return null;
  const day = counted.filter((l) => l.txn_date === lastDay);
  if (day.some((l) => l.balP === null)) return null;
  const ends = day.filter((l) => !day.some((o) => o !== l && Math.abs((o.balP as number) - o.netP - (l.balP as number)) <= 100));
  return ends.length === 1 ? ends[0].balP : null;
}

/** R-2522: the statement's own balance after the counted lines, in whole rupees (see statedPaise). */
export function statementBalanceAtMeet(counted: readonly Line[], uncounted: readonly Line[] = []): number | null {
  const p = statedPaise(counted.map((l) => toPaise(l, true)), uncounted);
  return p === null ? null : signedRound(p / 100);
}

type Meet = { balance: number; drift: number; linesOnOld: number };

function meetingPoint(before: readonly PLine[], newRows: readonly Line[], newOpening: number, oldDate: string, sameDay: boolean): Meet {
  /* R-2528: the database's rule — after the old date only by an EARLIER value date, or (second
     reading) dated ON the old date. A later line value-dated on the old date is that day's. */
  const belongs = (r: Line) => r.txn_date >= oldDate && (meetDate(r) < oldDate || (sameDay && r.txn_date === oldDate));
  const onOld = newRows.filter(belongs);
  const left = newRows.filter((r) => r.txn_date >= oldDate && !belongs(r));
  const counted = [...before, ...onOld.map((r) => toPaise(r, true))];
  const opening = signedRound(newOpening);
  const summed = opening + counted.reduce((s, r) => s + r.netR, 0);
  const summedP = opening * 100 + counted.reduce((s, r) => s + r.netP, 0);
  const statedP = statedPaise(counted, left);
  const tolerance = counted.every((l) => l.exact) ? MEET_PAISE_TOLERANCE : MEET_PAISE_TOLERANCE_UNKNOWN;
  if (statedP !== null && Math.abs(summedP - statedP) <= tolerance) {
    const stated = signedRound(statedP / 100);
    return { balance: stated, drift: summed - stated, linesOnOld: onOld.length };
  }
  return { balance: summed, drift: 0, linesOnOld: onOld.length };
}

export function openingMoveCheck(args: {
  /** Every statement line (new or already in the app). */
  rows: readonly Line[];
  /** R-2522: the statement lines NOT yet in the app (what the import adds). Default: all rows. */
  newRows?: readonly Line[];
  /** R-2522: the lines ALREADY in the app dated from the new date to the day before the old
      date — statement lines imported before AND hand-entered (manual) ones. After the move they
      are all counted, so the database counts them; given here, the preview counts exactly what
      the database will. Not given → the statement's own lines in that window stand in.
      R-2528: their paise are not known (whole rupees only). */
  existingInWindow?: readonly Line[];
  newOpening: number;
  newDate: string;
  oldOpening: number;
  oldDate: string | null | undefined;
  /** Old opening ≠ 0, or the account already has lines. */
  accountHasMoney: boolean;
}): OpeningMoveCheck {
  const { rows, newOpening, newDate, oldOpening, oldDate, accountHasMoney } = args;
  const newRows = args.newRows ?? rows;
  if (!accountHasMoney || !oldDate) return { kind: "none" };
  if (newDate >= oldDate) return { kind: "later", oldDate };
  /* The window [new date, old date): what will be in the app after the import — the lines
     already there plus the new ones (the database's rule). */
  const inWindow = (r: Line) => r.txn_date >= newDate && r.txn_date < oldDate;
  const before = args.existingInWindow
    ? [...args.existingInWindow.filter(inWindow).map((r) => toPaise(r, false)), ...newRows.filter(inWindow).map((r) => toPaise(r, true))]
    : rows.filter(inWindow).map((r) => toPaise(r, true));
  const byValue = meetingPoint(before, newRows, newOpening, oldDate, false);
  const sameDay = meetingPoint(before, newRows, newOpening, oldDate, true);
  const ok = (m: Meet) => Math.abs(m.balance - oldOpening) <= STATEMENT_TOLERANCE;
  const m = ok(byValue) ? byValue
    : ok(sameDay) ? sameDay
    : Math.abs(sameDay.balance - oldOpening) < Math.abs(byValue.balance - oldOpening) ? sameDay : byValue;
  const difference = m.balance - oldOpening;
  return {
    kind: "earlier",
    oldDate,
    oldOpening,
    balanceOnOldDate: m.balance,
    difference,
    matches: Math.abs(difference) <= STATEMENT_TOLERANCE,
    linesOnOldDate: m.linesOnOld,
    roundingDrift: m.drift,
  };
}

/** Lines dated before the opening date — inside the opening, not counted in the balance. */
export function linesBeforeOpening(rows: readonly { txn_date: string }[], openingDate: string | null | undefined): number {
  return rows.filter((r) => !countsAfterOpening(r, openingDate)).length;
}
