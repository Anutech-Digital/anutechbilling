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
 *   The meeting point now holds:
 *     • every line dated from the new date up to the day before the old date — the statement's
 *       new lines AND what the app already holds there, hand-entered lines too (after the move
 *       they are all counted; the database counts them, so the preview does: `existingInWindow`), and
 *     • every statement line that is NEW to the app and dated ON or before the old date, by its
 *       value date where the bank gives one (`meetDate`: the earlier of the two dates). A line
 *       the app already has on that date is part of the existing data, so it is not counted.
 *   And the figure is the statement's OWN running balance at that point, when it has one: the
 *   rupee-rounded amounts of 3,664 lines summed to ₹2 less than the bank's balance (paise), which
 *   is rounding, not a missing line. The summed figure is used instead when the balance column
 *   is missing or the two differ by more than rounding can explain (`roundingAllowance`, the
 *   account page's own rule) — a missing line still shows.
 *
 * The database checks the same thing on save (set_bank_opening_from_statement, on the stored
 * lines — R-2522 migration) and refuses unless the owner accepts the difference; this is the
 * preview of it.
 */
import { STATEMENT_TOLERANCE, countsAfterOpening } from "./running-balance";
import { roundingAllowance } from "./statement-check";

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
      /** balanceOnOldDate − oldOpening: how much today's balance would move. */
      difference: number;
      matches: boolean;
      /** R-2522: new lines dated on the old opening date (or with a value date on/before it)
          counted before the meeting point — the bank put them in that closing balance. */
      linesOnOldDate: number;
      /** R-2522: Σ(rounded amounts) − the statement's own balance, when the balance was used. */
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
 * statement-check's dayEnd). null when that day has a line without a balance, or no single end.
 */
export function statementBalanceAtMeet(counted: readonly Line[]): number | null {
  if (counted.length === 0) return null;
  const lastDay = counted.reduce((m, l) => (l.txn_date > m ? l.txn_date : m), counted[0].txn_date);
  const day = counted.filter((l) => l.txn_date === lastDay);
  if (day.some((l) => l.balance_after == null)) return null;
  const ends = day.filter((l) => !day.some((o) => o !== l && Math.abs(startOf(o) - (l.balance_after as number)) <= STATEMENT_TOLERANCE));
  return ends.length === 1 ? Math.round(ends[0].balance_after as number) : null;
}

export function openingMoveCheck(args: {
  /** Every statement line (new or already in the app). */
  rows: readonly Line[];
  /** R-2522: the statement lines NOT yet in the app (what the import adds). Default: all rows. */
  newRows?: readonly Line[];
  /** R-2522: the lines ALREADY in the app dated from the new date to the day before the old
      date — statement lines imported before AND hand-entered (manual) ones. After the move they
      are all counted, so the database counts them; given here, the preview counts exactly what
      the database will. Not loaded yet → the statement's own lines in that window stand in. */
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
  const onOld = newRows.filter((r) => r.txn_date >= oldDate && meetDate(r) <= oldDate);
  /* The window [new date, old date): what will be in the app after the import — the lines
     already there plus the new ones (the database's rule); before those are loaded, the
     statement's own lines in the window. */
  const inWindow = (r: Line) => r.txn_date >= newDate && r.txn_date < oldDate;
  const before = args.existingInWindow
    ? [...args.existingInWindow.filter(inWindow), ...newRows.filter(inWindow)]
    : rows.filter(inWindow);
  const counted = [...before, ...onOld];
  const summed = Math.round(newOpening + counted.reduce((s, r) => s + net(r), 0));
  const stated = statementBalanceAtMeet(counted);
  const useStated = stated !== null && Math.abs(summed - stated) <= roundingAllowance(counted.length);
  const balanceOnOldDate = useStated ? stated : summed;
  const difference = balanceOnOldDate - oldOpening;
  return {
    kind: "earlier",
    oldDate,
    oldOpening,
    balanceOnOldDate,
    difference,
    matches: Math.abs(difference) <= STATEMENT_TOLERANCE,
    linesOnOldDate: onOld.length,
    roundingDrift: useStated ? summed - stated : 0,
  };
}

/** Lines dated before the opening date — inside the opening, not counted in the balance. */
export function linesBeforeOpening(rows: readonly { txn_date: string }[], openingDate: string | null | undefined): number {
  return rows.filter((r) => !countsAfterOpening(r, openingDate)).length;
}
