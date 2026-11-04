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

import { utcDateISO } from "@/lib/dates/ist";

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
const toDay = (ms: number) => utcDateISO(new Date(ms));

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

/**
 * R-2377 — Business Loans → "Add loan": the dates to look in are ±15 days around "Taken on"
 * (there is no first EMI here). The server (record_business_loan, R-2377) re-checks the line.
 */
export function takenOnWindow(takenOn: string | null | undefined): { anchor: string; from: string; to: string } | null {
  if (!takenOn || Number.isNaN(toMs(takenOn))) return null;
  return {
    anchor: takenOn,
    from: toDay(toMs(takenOn) - DISBURSAL_DAYS * DAY),
    to: toDay(toMs(takenOn) + DISBURSAL_DAYS * DAY),
  };
}

/* Words every lender name has — they say nothing about WHICH lender it is. */
const GENERIC_LENDER_WORDS = new Set([
  "bank", "ltd", "limited", "pvt", "private", "the", "and", "finance", "financial", "services", "company", "corp", "nbfc", "loan", "loans",
]);

/** R-2377: the narration names the lender ("FT … BAJAJ FINANCE" for "Bajaj Finance"). */
export function lenderInNarration(description: string | null | undefined, lender: string | null | undefined): boolean {
  const words = (lender ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_LENDER_WORDS.has(w));
  if (words.length === 0) return false;
  const text = ` ${(description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return words.some((w) => text.includes(` ${w}`));   // a word starting with it ("BAJAJFIN" too)
}

/**
 * R-2377: the money-in lines that can be this loan's money — the R-2341 rule (account, money in,
 * not reconciled, amount ±₹1) within ±15 days of "Taken on"; lines naming the lender first, then
 * nearest date.
 */
export function businessLoanCandidates(
  lines: readonly MoneyInLine[], principal: number, takenOn: string | null | undefined, lender: string | null | undefined,
): MoneyInLine[] {
  const near = disbursalCandidates(lines, principal, takenOnWindow(takenOn));
  const named = near.filter((l) => lenderInNarration(l.description, lender));
  return [...named, ...near.filter((l) => !named.includes(l))];
}
