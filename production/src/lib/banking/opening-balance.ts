/**
 * Opening balance, read off a bank statement's own running-balance column.
 *
 * The balance on a date D is the balance just BEFORE the first line dated on/after D:
 *   that line's balance_after − its credit + its debit.
 *
 * ─── IT REFUSES RATHER THAN GUESSES ─────────────────────────────────────────
 * No balance column, or no line on/after D → null with a reason. A made-up opening
 * balance would silently shift every balance the account ever shows.
 *
 * ─── IT SAYS WHAT IT IS NOT SURE OF ─────────────────────────────────────────
 *  • `firstLineDate` later than D: the figure is the balance at the start of the
 *    statement. It equals the balance on D only if nothing moved in between — the
 *    statement cannot tell us, so the caller must say so.
 *  • `chainBreaks`: lines whose running balance does not follow from the previous line
 *    (±1 for rounding to whole rupees). A statement that does not add up is not one to
 *    take an opening balance from without looking.
 */

import { fyStartISO } from "@/lib/dates/ist";

export type StatementLine = {
  txn_date:      string;        // ISO YYYY-MM-DD
  debit:         number;
  credit:        number;
  balance_after: number | null;
};

export type OpeningBalanceResult =
  | {
      ok: true;
      /** Whole rupees. */
      amount: number;
      /** Date of the statement line the figure was derived from. */
      firstLineDate: string;
      /** Lines dated before D — already inside the opening balance. */
      linesBefore: number;
      chainBreaks: number;
    }
  | { ok: false; reason: string };

export function openingBalanceFromStatement(
  lines: StatementLine[],
  onDate: string,
): OpeningBalanceResult {
  if (lines.length === 0) return { ok: false, reason: "The statement has no lines." };
  if (lines.every((l) => l.balance_after === null)) {
    return {
      ok: false,
      reason: "This statement has no running-balance column, so the opening balance cannot be read from it. Enter it by hand on the account instead.",
    };
  }

  /* Statements come newest-first from some banks. Put them oldest-first, keeping the
     file's order within a day (that order is the only record of intra-day sequence). */
  const ordered = lines[0].txn_date > lines[lines.length - 1].txn_date ? [...lines].reverse() : lines;

  let chainBreaks = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].balance_after;
    const cur = ordered[i];
    if (prev === null || cur.balance_after === null) continue;
    if (Math.abs(prev - cur.debit + cur.credit - cur.balance_after) > 1) chainBreaks++;
  }

  const idx = ordered.findIndex((l) => l.txn_date >= onDate);
  if (idx === -1) {
    return {
      ok: false,
      reason: `No statement line is dated on or after ${onDate}, so the balance on that date is not on this statement.`,
    };
  }
  const first = ordered[idx];
  if (first.balance_after === null) {
    return {
      ok: false,
      reason: `The first line on or after ${onDate} (${first.txn_date}) has no balance, so the opening balance cannot be worked out from it.`,
    };
  }

  return {
    ok: true,
    amount: Math.round(first.balance_after - first.credit + first.debit),
    firstLineDate: first.txn_date,
    linesBefore: idx,
    chainBreaks,
  };
}

/** 1 April of the Indian financial year an ISO date falls in. */
export function fyStartFor(isoDate: string): string {
  return fyStartISO(isoDate);
}
