/**
 * R-736 (19 Oct 2026) — what /api/auth/signup may say about an address that already has a login.
 *
 * The route used to return GoTrue's own `authError.message` ("A user with this email address
 * has already been registered"), so the signup form doubled as a lookup: type any address and
 * learn whether it has a ResellerOS account. Now an existing address gets exactly the same
 * answer as a brand-new company signup ("check your email"), and the response for a real new
 * company no longer carries ids either, so the two cannot be told apart from the JSON.
 */

/** The body a fresh company signup returns (route.ts 3c) — and an existing address gets too. */
export const CHECK_EMAIL_RESPONSE = {
  success: true,
  status: "created",
  needsVerification: true,
  verificationSent: true,
} as const;

/** Any other createUser failure: no raw provider text, but still a next step (§24). */
export const SIGNUP_FAILED_MESSAGE =
  "We could not create the account. Check that the email address is typed correctly and try again. " +
  "If you already use ResellerOS, sign in instead — or use Forgot password on the sign-in page.";

/** Our own step failed (company / user record, or anything unexpected). Nothing was kept —
 *  the login made a moment earlier is rolled back — so trying again is safe. The database
 *  text is logged on the server only (lib/errors/api-error.ts, R-1137). */
export const SIGNUP_SERVER_FAILED_MESSAGE =
  "We could not finish setting up your account on our side, and nothing was saved. " +
  "Please try again in a minute. If it keeps happening, email support@anutech.in.";

/** GoTrue: code `email_exists` (422); older builds only the message. Auth.js store: same code (server/auth/accounts.ts). */
export function isEmailTaken(err: { message?: string; code?: string; status?: number } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "email_exists" || err.code === "user_already_exists") return true;
  return /already (been )?registered|already exists/i.test(err.message ?? "");
}
