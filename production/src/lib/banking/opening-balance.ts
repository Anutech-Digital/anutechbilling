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
 *    R-2522: only breaks the day-level check also sees (statement-check's gaps — the same check
 *    as the preview's "Balance chain" box). A line printed out of order INSIDE one day whose
 *    day-end balance is right is `outOfOrder` instead: an info note, nothing is missing. Staging
 *    HDFC FY 25-26: 7 such breaks, all on 21 Nov 2025 (two FD redemptions printed out of order),
 *    shown as a warning next to "Balance chain complete".
 */

import { fyStartISO } from "@/lib/dates/ist";
import { checkStatement } from "./statement-check";
import { signedRound } from "./statement-parse";

export type StatementLine = {
  txn_date:      string;        // ISO YYYY-MM-DD
  debit:         number;
  credit:        number;
  balance_after: number | null;
  /** R-2528: the printed paise (statement-parse), when the figure has them. */
  amount_paise?: number;
  balance_paise?: number;
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
      /** Breaks where money is missing (the day-level check agrees) — a warning. */
      chainBreaks: number;
      /** R-2522: breaks only because lines of one day are printed out of order, the day's
          closing balance right — an info note. Absent when none. */
      outOfOrder?: { lines: number; days: string[] };
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

  /* `at`: the line's date (where the day-level check would see it); `day`: the day printed out of
     order — the previous line's day when the break is on a new day's first line (the day before
     ended on a line that was not its last). */
  const breaks: { at: string; day: string }[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].balance_after;
    const cur = ordered[i];
    if (prev === null || cur.balance_after === null) continue;
    if (Math.abs(prev - cur.debit + cur.credit - cur.balance_after) > 1) {
      breaks.push({ at: cur.txn_date, day: ordered[i - 1].txn_date });
    }
  }
  /* R-2522: a break counts only where the day-level check finds money missing. */
  const gaps = breaks.length > 0 ? (checkStatement(ordered, 0)?.gaps ?? []) : [];
  const inGap = (d: string) => gaps.some((g) => (g.after < d && d <= g.by) || d === g.by);
  const chainBreaks = breaks.filter((b) => inGap(b.at)).length;
  const soft = breaks.filter((b) => !inGap(b.at));
  /* A break inside one day names that day; one on a day's first line names the day before only
     when that day has an inside break too (it ended on a line that was not its last). */
  const insideDays = new Set(soft.filter((b) => b.day === b.at).map((b) => b.at));
  const reordered = soft.map((b) => (b.day !== b.at && !insideDays.has(b.day) ? b.at : b.day));

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
    amount: openingFromLine(first),
    firstLineDate: first.txn_date,
    linesBefore: idx,
    chainBreaks,
    ...(reordered.length > 0 ? { outOfOrder: { lines: reordered.length, days: [...new Set(reordered)].sort() } } : {}),
  };
}

/**
 * R-2528: the balance before a line, worked out in PAISE when the statement printed them, then
 * rounded once — so the opening is at most 50 paise from the bank's (the opening move allows
 * exactly that much). From the rupee-rounded figures it could be ₹1 off (1,000.50 − 10.50).
 */
function openingFromLine(l: StatementLine): number {
  const balP = l.balance_paise ?? (l.balance_after as number) * 100;
  const amtP = l.amount_paise ?? (l.debit + l.credit) * 100;
  return signedRound((balP - (l.credit > 0 ? amtP : -amtP)) / 100);
}

/** 1 April of the Indian financial year an ISO date falls in. */
export function fyStartFor(isoDate: string): string {
  return fyStartISO(isoDate);
}
