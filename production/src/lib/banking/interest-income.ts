/**
 * R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"): a money-in line booked
 * as interest income — from an FD, a savings account or other — and an FD premature closure in one
 * save (principal back from the FD + interest), with the TDS the bank deducted.
 *
 * Money (book_bank_credit_as_interest, migration 20261102100702):
 *   Dr Bank = line · Cr FD account = principal · Dr TDS receivable = TDS · Cr Interest received = interest + TDS.
 */

export type InterestSource = "fd" | "savings" | "other";

/** Where the narration says the interest came from (the owner can change it). */
export function guessInterestSource(description: string | null | undefined): InterestSource {
  const d = description ?? "";
  if (/\b(fd|f\.d\.|fixed\s+dep\w*|term\s+dep\w*|td|premat\w*|closure|mat(urity)?\s+proc\w*)\b/i.test(d)) return "fd";
  if (/\b(sb|s\.b\.|savings?|sav)\b/i.test(d)) return "savings";
  return "other";
}

export type InterestSplit = {
  /** Interest credited on this line (line − principal). */
  interest: number;
  /** Interest income booked = interest credited + TDS deducted. */
  gross: number;
  /** Why it cannot be saved yet, in plain English; null = ready. */
  error: string | null;
};

/**
 * The parts of the bank line: principal back from the FD + interest credited = the line.
 * TDS is extra (it never reached the bank), so the income is interest + TDS.
 * fdBalance: the FD account's balance today, when known — principal may not be more.
 */
export function interestSplit(input: {
  credit: number;
  principal: number;
  tds: number;
  fdBalance?: number | null;
}): InterestSplit {
  const credit = Math.round(input.credit || 0);
  const principal = Math.round(input.principal || 0);
  const tds = Math.round(input.tds || 0);
  const interest = credit - principal;
  const gross = interest + tds;
  let error: string | null = null;
  if (principal < 0 || tds < 0) error = "Amounts cannot be negative.";
  else if (principal >= credit) error = "Principal must be less than the bank line — the rest is the interest.";
  else if (input.fdBalance != null && principal > input.fdBalance) error = "Principal is more than this FD's balance.";
  return { interest, gross, error };
}
