/**
 * R-281: rules for the local-only test login (POST /api/dev/test-login).
 *
 * Pardeep (6 Oct night) could not log in on localhost and asked for his own password on the
 * login page. That page ships to staging and live and its code is on GitHub (R-059/R-093), so
 * instead: one button per E2E test role, on localhost only. The browser sends just the ROLE;
 * the server picks the seeded test account (e2e/fixtures/e2e-roles.mjs) and its password from
 * server env / the gitignored .env.test. No password ever reaches the client or the code, and
 * never a real person's account.
 *
 * Every gate must pass, else the route answers 404 as if it did not exist:
 *   NEXT_PUBLIC_APP_ENV === "local"   (npm run dev:local sets it; staging/live never do)
 *   NODE_ENV !== "production"         (next dev only — never a build)
 *   request host is localhost / 127.0.0.1 / [::1]
 */

/** The roles e2e/fixtures/e2e-roles.mjs seeds. Kept in step by a test. No billing account exists. */
export const TEST_LOGIN_ROLES = ["owner", "manager", "accountant", "sales"] as const;
export type TestLoginRole = (typeof TEST_LOGIN_ROLES)[number];

export function isTestLoginRole(v: unknown): v is TestLoginRole {
  return typeof v === "string" && (TEST_LOGIN_ROLES as readonly string[]).includes(v);
}

/** Hostname out of a Host header ("localhost:3001", "[::1]:3001", "127.0.0.1"). */
export function hostName(hostHeader: string | null | undefined): string {
  const h = (hostHeader ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function testLoginAllowed(input: {
  appEnv: string | undefined;
  nodeEnv: string | undefined;
  host: string | null | undefined;
}): boolean {
  return (
    input.appEnv === "local" &&
    input.nodeEnv !== "production" &&
    LOCAL_HOSTS.has(hostName(input.host))
  );
}

/** Same names and default email as e2e-roles.mjs#roleCreds. Password has no default. */
export function testLoginCreds(
  role: TestLoginRole,
  env: Record<string, string | undefined>,
): { email: string; password: string | undefined } {
  const R = role.toUpperCase();
  return {
    email: (env[`E2E_${R}_EMAIL`] || `e2e-${role}@example.test`).trim().toLowerCase(),
    password: env[`E2E_${R}_PASSWORD`] || undefined,
  };
}

/**
 * Only the E2E_* lines of a .env.test text — `next dev` does not load .env.test, and nothing
 * else from that file (its Supabase URL/keys) may leak into the app.
 */
export function e2eVarsFromEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*(E2E_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
