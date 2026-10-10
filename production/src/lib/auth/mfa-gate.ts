/**
 * R-701: which API routes stay open while a two-factor login is half done (password given,
 * authenticator code not yet — session aal1, nextLevel aal2).
 *
 * Everything else under /api answers 401 until the code is entered. Before this, only pages
 * went to /mfa, so a stolen password alone could call every API route (invite an owner, set
 * a member's temporary password, reveal a vault secret, delete a tenant).
 *
 * Open on purpose — none of these act on the signed-in user's session:
 *   /api/public/*   customer site and quote links (no login at all)
 *   /api/webhooks/* signed by Razorpay, Meta, … not by a user
 *   /api/cron/*     CRON_SECRET
 *   /api/health/*, /api/version   uptime checks
 *   /api/monitoring/sentry-dsn   browser error reporting (public DSN, no session)
 *   three pre-login auth routes (signup, verify-email, resend-verification)
 * /api/auth/onboarding/* is NOT open: it creates or joins a workspace for the session user.
 */
const OPEN_PREFIXES = ["/api/public/", "/api/webhooks/", "/api/cron/", "/api/health/"] as const;
const OPEN_EXACT = new Set([
  "/api/version",
  "/api/monitoring/sentry-dsn",   // root layout asks for it on every page, /mfa included; public DSN only
  "/api/auth/signup",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
]);

/** True when this /api path must wait for the two-factor code. Non-API paths: false. */
export function apiNeedsMfaCode(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (OPEN_EXACT.has(path)) return false;
  return !OPEN_PREFIXES.some((p) => path.startsWith(p));
}

export const MFA_API_REFUSAL =
  "Enter the code from your authenticator app first. Open /mfa, type the 6-digit code, then try again.";
