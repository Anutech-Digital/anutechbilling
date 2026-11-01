/**
 * R-2341 — Set up this loan → "Loan money came into <account>": which money-in lines of the
 * imported statement can be the loan money, so the owner picks THAT line instead of adding a new
 * one (a new line next to the imported credit counts the same cash twice).
 *
 * A line qualifies when it is on the chosen account, money in (credit, no debit), not reconciled,
 * its amount is the loan amount within ₹1, and its date is within 15 days of when the money came
 * in — the date typed in "Received on", or else one month before the first EMI (a loan's first
 * EMI is usually a month after the money comes in) — and never after the first EMI (the server's
 * rule). Nearest date first. The server (record_emi_loan_taken, R-2341) re-checks all of it.
 */

export type MoneyInLine = {
  id: string;
  txn_date: string;            // YYYY-MM-DD
  credit: number | null;
  debit: number | null;
  description: string | null;
  matched_to_type: string | null;
};

export const DISBURSAL_DAYS = 15;
export const DISBURSAL_AMOUNT_SLACK = 1;

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One month before a YYYY-MM-DD date (31 Oct → 30 Sep, 31 Mar → 28/29 Feb). */
function monthBefore(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** The dates to look in: ±15 days around when the money came in, not after the first EMI. */
export function disbursalWindow(receivedOn: string | null | undefined, firstDueOn: string): { anchor: string; from: string; to: string } | null {
  if (!firstDueOn || Number.isNaN(toMs(firstDueOn))) return null;
  const anchor = receivedOn && !Number.isNaN(toMs(receivedOn)) ? receivedOn : monthBefore(firstDueOn);
  const from = toDay(toMs(anchor) - DISBURSAL_DAYS * DAY);
  const end = toDay(toMs(anchor) + DISBURSAL_DAYS * DAY);
  return { anchor, from, to: end < firstDueOn ? end : firstDueOn };
}

/** The lines that can be the loan money, nearest to the anchor date first. */
export function disbursalCandidates(
  lines: readonly MoneyInLine[], principal: number, window: { anchor: string; from: string; to: string } | null,
): MoneyInLine[] {
  if (!window || !(principal > 0)) return [];
  const a = toMs(window.anchor);
  return lines
    .filter((l) => l.matched_to_type == null
      && Number(l.credit ?? 0) > 0 && Number(l.debit ?? 0) === 0
      && Math.abs(Number(l.credit) - principal) <= DISBURSAL_AMOUNT_SLACK
      && l.txn_date >= window.from && l.txn_date <= window.to)
    .sort((x, y) => Math.abs(toMs(x.txn_date) - a) - Math.abs(toMs(y.txn_date) - a) || x.txn_date.localeCompare(y.txn_date));
}
