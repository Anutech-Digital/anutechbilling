/**
 * suite-health-verdict.mjs — the pure decision behind e2e/suite-health.spec.ts (R-855).
 *
 * Kept out of the spec so it can be unit-tested (src/test/suite-health-verdict.test.ts)
 * without Playwright. Names variables only — never values.
 *
 * Three outcomes:
 *   "pass" — everything the auth-gated specs need is set, so they really run.
 *   "skip" — CI, and NOT ONE auth variable is configured (the repo has no E2E secrets
 *            at all). The auth-gated specs cannot run there by design; the job then
 *            proves only the no-auth smoke, and the log says so in plain words.
 *   "fail" — anything else: a dev machine without .env.test, or a CI where SOME auth
 *            secrets exist but not all. That second case is the trap this guards:
 *            secrets present, yet the specs would silently skip and the run read green.
 *
 * Why skip only on "zero" and not on "partial": adding even one E2E secret is the
 * signal that someone intends the logged-in specs to run in CI. From that moment a
 * missing piece is a broken setup, not an absent one, and must go red.
 */
import { E2E_ROLES, missingEnvFor, roleEnvNames } from "./e2e-roles.mjs";

/** Every variable whose presence means "auth E2E is meant to run here". */
export function authSignalVars(roles = E2E_ROLES) {
  return [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    ...roles.map((r) => roleEnvNames(r).password),
  ];
}

/**
 * @param {{ env?: Record<string, string | undefined>, hasEnvFile: boolean, isCI: boolean }} input
 * @returns {{ status: "pass" | "skip" | "fail", missing: string[], reason: string }}
 */
export function suiteHealthVerdict({ env = process.env, hasEnvFile, isCI }) {
  const missing = [];
  // In CI the values come from repo secrets as env vars, never from a file; locally the
  // gitignored .env.test is the only supported source (playwright.config.ts reads it).
  if (!isCI && !hasEnvFile) missing.push("production/.env.test does not exist");
  if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY && !env.SUPABASE_ANON_KEY) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY is not set");
  // R-053: the logged-in workflow specs (wNN-*.spec.ts) skip per role without these.
  for (const name of missingEnvFor(E2E_ROLES, env)) {
    if (!name.startsWith("E2E_")) continue; // the Supabase vars are reported above
    missing.push(`${name} is not set — the logged-in workflow specs for that role skip`);
  }

  if (missing.length === 0) {
    return { status: "pass", missing, reason: "all auth E2E variables are set — auth-gated specs run" };
  }

  const anySignal = authSignalVars().some((n) => Boolean(env[n]));
  if (isCI && !anySignal && !hasEnvFile) {
    return {
      status: "skip",
      missing,
      reason:
        "SKIPPED: this CI has no E2E auth secrets at all (none of " +
        authSignalVars().join(", ") +
        "), so the auth-gated specs are NOT run here — only the no-auth smoke " +
        "(smoke + public buy page) ran. Adding ANY of those secrets turns this check back " +
        "into a hard gate. Card R-839 tracks the Auth.js login/seed the auth specs need.",
    };
  }

  return {
    status: "fail",
    missing,
    reason: isCI
      ? "Some E2E auth secrets are configured in CI but not all, so the auth-gated specs would silently skip."
      : "This machine has no complete E2E auth setup, so the auth-gated specs silently skip.",
  };
}
