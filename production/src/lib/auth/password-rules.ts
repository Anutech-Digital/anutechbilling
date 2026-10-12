/**
 * What counts as an acceptable new password, in one place.
 *
 * Client-safe on purpose: no `node:crypto`, no server-only import. `lib/vault/personal/pin.ts`
 * imported `node:crypto` and a client component pulled `PIN_LENGTH` out of it, which turned the
 * whole `/vault/personal` route into a 500 (`UnhandledSchemeError`) while typecheck, lint and
 * the test suite all stayed green. Same split as `pin-rules.ts`: rules here, secrets elsewhere.
 *
 * Supabase enforces its own minimum (6 by default) and returns its own message. These rules sit
 * in FRONT of that so the operator is told before submitting rather than after — and so
 * "password too short" is not the first thing they learn about a link that may have expired.
 */

/** Supabase's default floor is 6. Eight is this app's own, and the login form already uses 6. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Rejected outright. Not a strength meter — just the handful that show up in real breach lists
 * and in this repo's own history: a "<Product>@<year>" value sat in the login page's dev demo
 * list as a live owner credential (R-059), which is exactly the kind of value that gets reused
 * because it looks deliberate — so the company and product names are refused below as well.
 */
const BANNED = [
  "password", "12345678", "123456789", "qwerty123", "admin123",
  "welcome1", "letmein1", "iloveyou", "resellerost",
] as const;

export interface PasswordProblem {
  /** Shown under the field. Says what to do, not just what is wrong (CLAUDE.md §24). */
  message: string;
}

/**
 * Returns null when the password is acceptable, or the first problem found.
 *
 * One problem at a time, deliberately: a list of four complaints under a password field reads
 * as a wall and gets skimmed. The order is cheapest-to-fix first.
 */
export function checkNewPassword(password: string, confirm?: string): PasswordProblem | null {
  if (!password) {
    return { message: "Enter a new password." };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { message: `Use at least ${PASSWORD_MIN_LENGTH} characters — longer is what actually helps.` };
  }
  /* Trailing spaces are invisible in a masked field and survive into the stored password, so the
     next sign-in fails with no way to see why. Reject rather than silently trim: silently
     trimming means the password they think they set is not the one that works. */
  if (password !== password.trim()) {
    return { message: "Remove the space at the start or end — you cannot see it when typing, and it becomes part of the password." };
  }
  if (BANNED.includes(password.toLowerCase() as (typeof BANNED)[number])) {
    return { message: "That one is on every guess list. Pick something only you would think of." };
  }
  /* R-059: "<Company>@<year>" passwords were found in this repo. A name everyone in the
     company knows is the first thing anyone tries. */
  if (/reseller\s*os|anutech/i.test(password)) {
    return { message: "Don't use the company or product name in your password — it is the first thing anyone guesses." };
  }
  if (/^(.)\1+$/.test(password)) {
    return { message: "That is the same character repeated. Mix it up." };
  }
  if (confirm !== undefined && password !== confirm) {
    return { message: "The two passwords do not match." };
  }
  return null;
}

/**
 * Changing a password you already know: the new one must be acceptable AND different.
 *
 * The new password is judged FIRST, deliberately. Somebody who typed a weak new password
 * should be told that, not sent hunting for a typo in the old one — and neither answer
 * leaks anything, because the rules are public and the account is already proved by the
 * session before this is reached.
 */
export function checkPasswordChange(current: string, next: string): PasswordProblem | null {
  const problem = checkNewPassword(next);
  if (problem) return problem;
  if (next === current) {
    return { message: "That is the password you already have. Pick a different one." };
  }
  return null;
}
