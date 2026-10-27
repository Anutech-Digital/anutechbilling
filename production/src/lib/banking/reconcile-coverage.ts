/**
 * R-1869 — "Reconciled so far": how much of the account's money the books account for.
 *
 * Replaces the "Balance in app" tile (R-1829 / R-1831 era): opening balance + ONLY the
 * reconciled lines. That is not a balance of anything — with ₹26 lakh of credits still
 * unreconciled and the salaries already matched, it showed ₹-19,17,804 in red, which looks like
 * the account is overdrawn. Seen on a staging account of 1,449 lines (24 Oct 2026).
 *
 * The honest measure is COVERAGE, not cash: of all the money that moved through the account
 * (money in + money out, each line counted once at its own amount), how much has a record in the
 * books. Every number here is ≥ 0; the cash figure stays where it is true — "Balance in bank".
 * Percent rounds DOWN, so 100% means nothing at all is left.
 */
export type CoverageLine = { debit: number; credit: number; matched_to_type: string | null };

export type ReconcileCoverage = {
  totalLines: number;
  reconciledLines: number;
  leftLines: number;
  /** Rupees moved: Σ (debit + credit) over every line. */
  totalAmount: number;
  reconciledAmount: number;
  leftAmount: number;
  /** The still-unreconciled money split by direction. */
  leftIn: number;
  leftOut: number;
  /** 0–100, rounded down. */
  percent: number;
  /** Every line reconciled (and there is at least one). */
  done: boolean;
};

export function reconcileCoverage(lines: readonly CoverageLine[]): ReconcileCoverage {
  // Paise integers — rupee sums of statement lines with paise must not leave float tails.
  let totP = 0, recP = 0, leftInP = 0, leftOutP = 0, recLines = 0;
  for (const t of lines) {
    const inP = Math.round(Math.max(0, t.credit ?? 0) * 100);
    const outP = Math.round(Math.max(0, t.debit ?? 0) * 100);
    totP += inP + outP;
    if (t.matched_to_type !== null) { recP += inP + outP; recLines += 1; }
    else { leftInP += inP; leftOutP += outP; }
  }
  const leftLines = lines.length - recLines;
  const percent = totP === 0 ? (lines.length > 0 && leftLines === 0 ? 100 : 0) : Math.floor((recP * 100) / totP);
  return {
    totalLines: lines.length,
    reconciledLines: recLines,
    leftLines,
    totalAmount: totP / 100,
    reconciledAmount: recP / 100,
    leftAmount: (leftInP + leftOutP) / 100,
    leftIn: leftInP / 100,
    leftOut: leftOutP / 100,
    percent: leftLines === 0 && lines.length > 0 ? 100 : Math.min(percent, 99),
    done: lines.length > 0 && leftLines === 0,
  };
}
