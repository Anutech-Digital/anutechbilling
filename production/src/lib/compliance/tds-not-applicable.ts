/**
 * R-181 — a month with no TDS deducted has nothing to deposit.
 *
 * "Deposit TDS deducted" is due by the 7th for the TDS deducted LAST month. If the
 * books show no TDS at all for that month (no salary TDS, no vendor TDS), there is
 * no challan to pay, so the period is not applicable — showing it red and
 * "overdue" only frightens the operator. Month-end Close already says the same
 * thing ("Is mahine kuch withheld nahi hua"); this keeps the Compliance page, the
 * /today inbox and the reminder email in line with it.
 *
 * Only months that have ENDED are judged. The running month can still get a
 * salary run or a vendor bill with TDS, so it is never N/A.
 */

export type NotApplicable = (obligationKey: string, periodKey: string) => boolean;

export const TDS_DEPOSIT_KEY = "tds_payment";

import { istMonth, utcDateISO } from "@/lib/dates/ist";

/** Months (YYYY-MM) in which any TDS was deducted — salary periods + expense dates. */
export function tdsMonthsFrom(
  salary: { period: string | null; tds: number | string | null }[] | null | undefined,
  expenses: { expense_date: string | null; tds_amount: number | string | null }[] | null | undefined,
): Set<string> {
  const months = new Set<string>();
  for (const s of salary ?? []) {
    if (s.period && (Number(s.tds) || 0) > 0) months.add(s.period.slice(0, 7));
  }
  for (const e of expenses ?? []) {
    if (e.expense_date && (Number(e.tds_amount) || 0) > 0) months.add(e.expense_date.slice(0, 7));
  }
  return months;
}

/** How many past months to read TDS for — the picker looks back at most ~2 months. */
export const TDS_LOOKBACK_MONTHS = 4;

/** First day (YYYY-MM-01) of the lookback window, for the TDS queries. */
export function tdsLookbackFrom(today: Date): string {
  const [y, m] = istMonth(today).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - TDS_LOOKBACK_MONTHS, 1));
  return utcDateISO(d);
}

/**
 * The predicate buildComplianceRows takes: true when the TDS deposit for a
 * finished month has no TDS behind it. Never true for any other obligation.
 */
export function noTdsDeductedPredicate(tdsMonths: ReadonlySet<string>, today: Date): NotApplicable {
  const current = istMonth(today);
  return (obligationKey, periodKey) =>
    obligationKey === TDS_DEPOSIT_KEY
    && /^\d{4}-\d{2}$/.test(periodKey)
    && periodKey < current
    && !tdsMonths.has(periodKey);
}
