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
 *   And the figure is the statement's OWN running balance at that point, when it has one: the
 *   rupee-rounded amounts of 3,664 lines summed to ₹2 less than the bank's balance (paise), which
 *   is rounding, not a missing line. The summed figure is used instead when the balance column
 *   is missing, when a new line of that last day is NOT counted (its balance would be in the
 *   figure), or when the two differ by more than rounding can explain: roundingAllowance(n),
 *   capped at MEET_ROUNDING_CAP so a missing line stays visible on a long statement. The drift
 *   itself is returned (and stored in the history by the database) — it is the ₹ by which
 *   today's balance moves.
 *
 * The database checks the same thing on save (set_bank_opening_from_statement, on the stored
 * lines — R-2522 migration) and refuses unless the owner accepts the difference; this is the
 * preview of it.
 */
import { STATEMENT_TOLERANCE, countsAfterOpening } from "./running-balance";
import { roundingAllowance } from "./statement-check";

/** R-2522: the most the summed figure may differ from the bank's balance and still count as paise
    rounding (the database uses the same 25). */
export const MEET_ROUNDING_CAP = 25;

type Line = {
  txn_date: string;
  /** R-2522: the bank's value date, when the statement prints one. */
  value_date?: string | null;
  debit: number;
  credit: number;
  balance_after?: number | null;
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

const net = (l: Line) => (l.credit ?? 0) - (l.debit ?? 0);
const startOf = (l: Line) => (l.balance_after as number) + (l.debit ?? 0) - (l.credit ?? 0);

/**
 * R-2522: the statement's own balance after the counted lines — the closing balance of their
 * last day: the one line of that day no other line of the day continues from (order-free, as
 * statement-check's dayEnd). null when that day has a line without a balance, no single end, or
 * a line of that day left out (`uncounted` — its amount would be inside the figure).
 */
export function statementBalanceAtMeet(counted: readonly Line[], uncounted: readonly Line[] = []): number | null {
  if (counted.length === 0) return null;
  const lastDay = counted.reduce((m, l) => (l.txn_date > m ? l.txn_date : m), counted[0].txn_date);
  if (uncounted.some((l) => l.txn_date === lastDay)) return null;
  const day = counted.filter((l) => l.txn_date === lastDay);
  if (day.some((l) => l.balance_after == null)) return null;
  const ends = day.filter((l) => !day.some((o) => o !== l && Math.abs(startOf(o) - (l.balance_after as number)) <= STATEMENT_TOLERANCE));
  return ends.length === 1 ? Math.round(ends[0].balance_after as number) : null;
}

type Meet = { balance: number; drift: number; linesOnOld: number };

function meetingPoint(before: readonly Line[], newRows: readonly Line[], newOpening: number, oldDate: string, sameDay: boolean): Meet {
  const belongs = (r: Line) => r.txn_date >= oldDate && (sameDay ? meetDate(r) <= oldDate : meetDate(r) < oldDate);
  const onOld = newRows.filter(belongs);
  const left = newRows.filter((r) => r.txn_date >= oldDate && !belongs(r));
  const counted = [...before, ...onOld];
  const summed = Math.round(newOpening + counted.reduce((s, r) => s + net(r), 0));
  const stated = statementBalanceAtMeet(counted, left);
  const allowance = Math.min(roundingAllowance(counted.length), MEET_ROUNDING_CAP);
  const useStated = stated !== null && Math.abs(summed - stated) <= allowance;
  return { balance: useStated ? stated : summed, drift: useStated ? summed - stated : 0, linesOnOld: onOld.length };
}

export function openingMoveCheck(args: {
  /** Every statement line (new or already in the app). */
  rows: readonly Line[];
  /** R-2522: the statement lines NOT yet in the app (what the import adds). Default: all rows. */
  newRows?: readonly Line[];
  /** R-2522: the lines ALREADY in the app dated from the new date to the day before the old
      date — statement lines imported before AND hand-entered (manual) ones. After the move they
      are all counted, so the database counts them; given here, the preview counts exactly what
      the database will. Not given → the statement's own lines in that window stand in. */
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
    ? [...args.existingInWindow.filter(inWindow), ...newRows.filter(inWindow)]
    : rows.filter(inWindow);
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
