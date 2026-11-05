/**
 * R-2497 — moving a bank account's opening balance from a statement must keep today's balance.
 *
 * The opening is the balance at the START of its date, so it already holds every earlier line.
 * When an import sets an EARLIER opening (e.g. Excel's FY 25-26 statement, 1 Apr 2025, on an
 * account opened at 1 Apr 2026), the statement's balance at the start of the OLD opening date —
 * new opening + the statement's lines from the new date up to the day before the old date —
 * must equal the old opening (±₹1, statements carry paise). Otherwise today's balance would
 * change: a line is missing, or the date is wrong.
 *
 * The database checks the same thing on save (set_bank_opening_from_statement, on the stored
 * lines) and refuses unless the owner accepts the difference; this is the preview of it.
 */
import { STATEMENT_TOLERANCE } from "./running-balance";

type Line = { txn_date: string; debit: number; credit: number };

export type OpeningMoveCheck =
  /** Nothing to keep: the account has no money yet (opening 0, no lines). */
  | { kind: "none" }
  /** Same or later date: the database compares on save (it needs the stored lines). */
  | { kind: "later"; oldDate: string }
  | {
      kind: "earlier";
      oldDate: string;
      oldOpening: number;
      /** The statement's balance at the start of the old opening date. */
      balanceOnOldDate: number;
      /** balanceOnOldDate − oldOpening: how much today's balance would move. */
      difference: number;
      matches: boolean;
    };

export function openingMoveCheck(args: {
  rows: readonly Line[];
  newOpening: number;
  newDate: string;
  oldOpening: number;
  oldDate: string | null | undefined;
  /** Old opening ≠ 0, or the account already has lines. */
  accountHasMoney: boolean;
}): OpeningMoveCheck {
  const { rows, newOpening, newDate, oldOpening, oldDate, accountHasMoney } = args;
  if (!accountHasMoney || !oldDate) return { kind: "none" };
  if (newDate >= oldDate) return { kind: "later", oldDate };
  const moved = rows
    .filter((r) => r.txn_date >= newDate && r.txn_date < oldDate)
    .reduce((s, r) => s + (r.credit ?? 0) - (r.debit ?? 0), 0);
  const balanceOnOldDate = Math.round(newOpening + moved);
  const difference = balanceOnOldDate - oldOpening;
  return {
    kind: "earlier",
    oldDate,
    oldOpening,
    balanceOnOldDate,
    difference,
    matches: Math.abs(difference) <= STATEMENT_TOLERANCE,
  };
}

/** Lines dated before the opening date — inside the opening, not counted in the balance. */
export function linesBeforeOpening(rows: readonly { txn_date: string }[], openingDate: string | null | undefined): number {
  if (!openingDate) return 0;
  return rows.filter((r) => r.txn_date < openingDate).length;
}

/** The database's refusal for a statement that does not match (hint r2497_opening_mismatch). */
export function isOpeningMismatchError(err: unknown): boolean {
  const e = err as { hint?: unknown; message?: unknown } | null;
  return !!e && (e.hint === "r2497_opening_mismatch" || (typeof e.message === "string" && e.message.includes("The figures differ — set it anyway")));
}
