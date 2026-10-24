/**
 * R-1583 — when the TDS deducted in a month must be deposited (challan 281).
 *
 * Rule 30(1) of the Income-tax Rules, 1962 (non-government deductor): by the 7th of the
 * next month, EXCEPT tax deducted in March, which is due by 30 April. Every place that
 * shows or judges this deadline — the Compliance Calendar row "Deposit TDS deducted",
 * the /today inbox and the compliance-reminders cron (both through obligations.ts), and
 * Month-end Close — reads it from here, so March cannot drift back to 7 April in one of them.
 *
 * Pure string arithmetic on "YYYY-MM": no Date, so no timezone can move the day.
 */

export const TDS_DEPOSIT_DAY = 7;

/** "YYYY-MM" (the month the TDS was deducted in) → its deposit due date "YYYY-MM-DD". */
export function tdsDepositDueDate(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) throw new Error(`tdsDepositDueDate: period must be YYYY-MM, got "${period}"`);
  const y = Number(m[1]), mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`tdsDepositDueDate: bad month in "${period}"`);
  if (mon === 3) return `${y}-04-30`;
  const ny = mon === 12 ? y + 1 : y, nm = mon === 12 ? 1 : mon + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(TDS_DEPOSIT_DAY).padStart(2, "0")}`;
}
