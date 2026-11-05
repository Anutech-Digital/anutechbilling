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

/** The narration says interest (INT.PD, INTEREST, FD INT …) — then "Interest received" is picked first. */
export function looksLikeInterest(description: string | null | undefined): boolean {
  return /\b(int\.?\s?pd|interest|int\s+cr|fd\s+int|sb\s+int|int\.?\s+credit|int\.?\s+on\s+(fd|td|sb|dep\w*))\b/i.test(description ?? "");
}

/** An FD account as the redeem guess needs it. */
export type FdForGuess = { id: string; name: string; account_number_last4?: string | null };

/**
 * R-2390 (staging 2 Nov): the ₹40,02,110 "…AUTO_REDEEM" line pre-picked "Other income" — one click
 * would have booked ₹40 L of FD principal as income. Does the narration say an FD came back
 * (REDEEM / PREMAT / SWEEP, or names one of our FDs by number), and which FD?
 *   fdId   — the ONE FD whose number (6+ digits in its name) or last 4 digits ends a 6+ digit run in
 *            the narration; two FDs fit → null (the owner picks).
 *   redeem — a redeem word, or an FD named on a line that does not say interest ("INT ON FD 5012"
 *            is interest on the FD, not its closure).
 */
export function fdRedeemGuess(description: string | null | undefined, fds: readonly FdForGuess[]): { redeem: boolean; fdId: string | null } {
  const d = (description ?? "").replace(/[_-]+/g, " ");
  const word = /\b(redeem\w*|redemption|premat\w*|pre\s?mat\w*|auto\s?redeem\w*|auto\s?sweep\w*|sweep\w*)\b/i.test(d);
  const runs = d.match(/\d{6,}/g) ?? [];
  const hits = fds.filter((fd) => {
    const own = (fd.name.match(/\d{6,}/g) ?? []);
    const last4 = (fd.account_number_last4 ?? "").replace(/\D/g, "");
    return runs.some((r) => own.some((n) => r === n || r.endsWith(n) || n.endsWith(r)) || (last4.length === 4 && r.endsWith(last4)));
  });
  const fdId = hits.length === 1 ? hits[0].id : null;
  return { redeem: word || (fdId !== null && !looksLikeInterest(description)), fdId };
}
