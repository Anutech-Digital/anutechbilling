// Not wired yet — R-1608 (built, kept for later)
/**
 * Subscription start-date logic — pure, unit-tested.
 *
 * MONEY-CORRECTNESS: TS twin of the start-date rule in migration
 * 0076_record_payment_line_start_date.sql. On first payment, record_payment
 * creates the subscription with:
 *
 *   start_date   = the line's start_date when the operator set one, else the
 *                  payment date  →  coalesce(nullif(start_date,''), current_date)
 *   renewal_date = start_date + 1 year
 *
 * Keeping this decision here (mirroring bulk.ts ↔ 0075) makes the behaviour
 * unit-testable without a live Postgres. If the SQL rule changes, change both.
 */

/** Resolve the subscription start date: the line's explicit start, else the payment date. */
export function subscriptionStartDate(
  lineStartDate: string | null | undefined,
  paymentDate: string,
): string {
  const explicit = (lineStartDate ?? "").trim();
  return explicit.length > 0 ? explicit : paymentDate;
}
