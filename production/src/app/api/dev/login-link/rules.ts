/**
 * R-878: rules for the local-only login link (GET /api/dev/login-link).
 *
 * The desktop AI tester logs in as every role (owner / manager / sales / accountant …) on its
 * own dev server. `scripts/dev/local-login-link.mjs <email>` mints a one-time magic-link token
 * on the LOCAL GoTrue and prints a link to this route; the route verifies the token hash and
 * sets the session cookie. No password is typed, sent or stored.
 *
 * Every gate must pass, else the route answers 404 as if it did not exist:
 *   NEXT_PUBLIC_APP_ENV === "local"   (npm run dev:local sets it; staging/live never do)
 *   NODE_ENV !== "production"         (next dev only — never a build)
 *   request host is localhost / 127.0.0.1 / [::1] / *.localhost
 *     (*.localhost resolves to this machine; tester1.localhost, tester2.localhost … give each
 *      tester its own cookie jar, which ports alone do not)
 * and the account must be an @example.test address — never a real person.
 */

/** Hostname out of a Host header ("localhost:3001", "[::1]:3001", "tester1.localhost:3008"). */
export function hostName(hostHeader: string | null | undefined): string {
  const h = (hostHeader ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function isLocalHostName(name: string): boolean {
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "[::1]" ||
    /^(?:[a-z0-9-]+\.)+localhost$/.test(name)
  );
}

export function loginLinkAllowed(input: {
  appEnv: string | undefined;
  nodeEnv: string | undefined;
  host: string | null | undefined;
}): boolean {
  return input.appEnv === "local" && input.nodeEnv !== "production" && isLocalHostName(hostName(input.host));
}

/** Only @example.test — the .test TLD can never be a real mailbox. */
export function isTestEmail(email: string | null | undefined): boolean {
  return /^[a-z0-9._+-]+@example\.test$/.test((email ?? "").trim().toLowerCase());
}

/** GoTrue token hashes are hex / url-safe; anything else is not ours. */
export function isTokenHash(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(v);
}
