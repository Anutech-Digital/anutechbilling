/**
 * R-472 — checks for the referral partner fields, shared by "Add partner" (Referrals page)
 * and "Add referral" (customer page).
 *
 * PAN: the 194H TDS return needs the partner's real PAN. "abc" used to save silently.
 * Format: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F). Blank is allowed — PAN is
 * optional until you deduct TDS.
 *
 * Commission %: the box used to START with "10" as a real value that looked like a
 * placeholder, so typing "150" gave "10150". It now starts empty; this says what is wrong.
 */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Uppercase, spaces removed — what we save. */
export function normalisePan(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** null when fine (or blank); otherwise the message to show under the field. */
export function panProblem(raw: string): string | null {
  const pan = normalisePan(raw);
  if (pan === "") return null;
  if (!PAN_PATTERN.test(pan)) return "PAN must be 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).";
  return null;
}

/** null when the percent is usable; otherwise what to fix. */
export function commissionPercentProblem(raw: string): string | null {
  if (raw.trim() === "") return "Enter the partner's share, e.g. 10 for 10%.";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return "Percent must be more than 0 and at most 100.";
  return null;
}
