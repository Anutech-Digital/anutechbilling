/**
 * Say an amount the way an Indian owner reads it — "50 lakh", "5.9 lakh", "1.2 crore" —
 * under the box it is typed into.
 *
 * ₹50,00,000 and ₹5,00,000 differ by one zero and look almost the same in a form; "50 lakh"
 * and "5 lakh" do not. A ₹50L contract was booked as ₹5L (26 Sep 2026) because nothing on
 * screen said the number back in words. And a number wildly off its reference (the lead's
 * budget, the bank receipt) is flagged before it is saved — once invoiced it can only be
 * corrected with a credit / debit note.
 */

const trim = (n: number) => {
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.?0+$/, "");
};

/** "₹50,00,000" → "50 lakh"; "₹85,000" → "85 hazaar"; "₹1,20,00,000" → "1.2 crore". */
export function amountInIndianWords(rupees: number): string {
  const n = Math.abs(Math.round(rupees));
  const sign = rupees < 0 ? "minus " : "";
  if (n >= 1_00_00_000) return `${sign}${trim(n / 1_00_00_000)} crore`;
  if (n >= 1_00_000)    return `${sign}${trim(n / 1_00_000)} lakh`;
  if (n >= 1_000)       return `${sign}${trim(n / 1_000)} hazaar`;
  return `${sign}${n} rupaye`;
}

/**
 * A warning when `entered` is 5× or more away from `reference` in either direction — the size
 * of a slipped zero, not of a negotiation. Null when either side is missing or they are close.
 */
export function magnitudeWarning(entered: number, reference: number | null | undefined, referenceLabel: string): string | null {
  if (!reference || reference <= 0 || !entered || entered <= 0) return null;
  const ratio = entered / reference;
  if (ratio >= 5 || ratio <= 0.2) {
    return `This is ${amountInIndianWords(entered)}, while ${referenceLabel} was ${amountInIndianWords(reference)} — is a zero missing or extra?`;
  }
  return null;
}
