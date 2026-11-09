/**
 * Which financial year a Zoho invoice belongs to — moved unchanged out of bulk-reconcile-plan.ts (R-2621,
 * to keep that file under the max-lines limit); the plan re-exports them, so imports stay the same.
 */

/** The financial year (the calendar year of its April) a date falls in. */
export function fyOf(iso: string): number {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
}

/** The financial year printed in an invoice number ("INV/25-26/0412" → 2025); null = none. */
export function fyInNumber(no: string): number | null {
  const m = /(?:^|[^0-9])(\d{2})-(\d{2})(?:[^0-9]|$)/.exec(no);
  if (!m) return null;
  const a = Number(m[1]);
  return (a + 1) % 100 === Number(m[2]) ? 2000 + a : null;
}

/** (a) A Zoho invoice from before the app's books — its money settles the opening receivable.
 *  R-2494: the invoice's DATE decides, never its number (Zoho kept INV/25-26/… for a day or two
 *  after 1 Apr): dated before the books' start → opening. R-2496: the books' start is the company's
 *  ONE setting (lib/accounting/books-start.ts — Accounting → Overview → Books start, else the
 *  opening balances date + 1). No books' start → an earlier financial year than the bank line (the
 *  plan then refuses an opening invoice anyway). The number's year is used only when Zoho gives no
 *  date. Works for any books' start (1 Apr 2025, 1 Apr 2026, …). */
export function isLastYearInvoice(inv: { number: string; date: string | null }, lineDate: string, booksStart: string | null): boolean {
  const d = inv.date?.slice(0, 10);
  if (d) return booksStart ? d < booksStart : fyOf(d) < fyOf(lineDate);
  return (fyInNumber(inv.number) ?? Infinity) < fyOf(booksStart ?? lineDate); /* no number year → false */
}

/** R-2494: the number says an earlier financial year than the invoice's own date ("INV/25-26/0999"
 *  dated 2 Apr 2026) — Zoho kept the old number series after the year turned. */
export function oldNumberSeries(inv: { number: string; date: string | null }): boolean {
  const fy = fyInNumber(inv.number), d = inv.date?.slice(0, 10);
  return fy !== null && !!d && fy < fyOf(d);
}
