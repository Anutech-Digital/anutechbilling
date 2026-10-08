/**
 * e2e-roles.mjs — ONE place that says who the logged-in E2E users are (R-053).
 *
 * Shared by the seed script (plain node, `seed-e2e-tenant.mjs`) and the Playwright
 * fixtures (`roles.ts`), so the env var names can never drift between "the user we
 * created" and "the user we log in as".
 *
 * Passwords come ONLY from env (GitHub secrets in CI, a gitignored .env.test locally).
 * There is deliberately no default password: a spec whose role has no password SKIPS
 * with a reason that names the missing variable, and suite-health counts those skips.
 */

/** The single test company every logged-in spec runs inside. */
export const E2E_TENANT_NAME = "E2E Test Co";
/** Marker email on the tenant row — how the seed finds "its" tenant again (idempotent). */
export const E2E_TENANT_EMAIL = "e2e-company@example.test";
/** The one customer the seed creates; specs look it up by this exact name. */
export const E2E_CUSTOMER_NAME = "E2E Customer Pvt Ltd";
/** Bank account the seed creates (payroll "Pay from"). */
export const E2E_BANK_NAME = "E2E Bank Current A/c";
/** GST-registered vendor the seed creates (expense → input GST needs a vendor GSTIN). */
export const E2E_VENDOR_NAME = "E2E Vendor Pvt Ltd";
export const E2E_VENDOR_GSTIN = "27AAACV2053E1Z1"; // format-valid, synthetic

/** @type {readonly ["owner", "manager", "sales", "accountant"]} */
export const E2E_ROLES = /** @type {const} */ (["owner", "manager", "sales", "accountant"]);

/** @param {string} role */
export function roleEnvNames(role) {
  const R = role.toUpperCase();
  return { email: `E2E_${R}_EMAIL`, password: `E2E_${R}_PASSWORD` };
}

/**
 * Email + password for a role. Email defaults to e2e-<role>@example.test (the .test
 * TLD can never deliver mail). Password has NO default — undefined when unset.
 * @param {string} role
 */
export function roleCreds(role, env = process.env) {
  const names = roleEnvNames(role);
  return {
    role,
    email: (env[names.email] || `e2e-${role}@example.test`).trim().toLowerCase(),
    password: env[names.password] || undefined,
  };
}

/**
 * What is missing before a spec that logs in as `roles` can run. Empty array = ready.
 * Names variables only — never values.
 * @param {readonly string[]} roles
 */
export function missingEnvFor(roles, env = process.env) {
  const missing = [];
  for (const r of roles) {
    const n = roleEnvNames(r);
    if (!env[n.password]) missing.push(n.password);
  }
  if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY && !env.SUPABASE_ANON_KEY) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  if (!env.NEXT_PUBLIC_SUPABASE_URL && !env.SUPABASE_URL) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  return missing;
}

/* ── Production deny list ──────────────────────────────────────────────────────
   The seed creates users and resets their passwords; the specs create invoices,
   credit notes and salary runs. None of that may ever touch production. Hard-coded
   on purpose — an env var that "allows prod" is exactly the switch nobody should
   be able to flip by accident. */
const DENY_EXACT = new Set([
  "reselleros.anutech.in",
  "anutech.in",
  "www.anutech.in",
  "api.anutech.in",
  "ontpnqjoysjgrlsukecm.supabase.co", // the old hosted production Supabase project
]);

/**
 * Why `urlOrHost` is a production host, or null if it is not on the deny list.
 * @param {string | undefined | null} urlOrHost
 */
export function productionHostReason(urlOrHost) {
  if (!urlOrHost) return null;
  let host;
  try {
    host = new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return `could not parse "${urlOrHost}" as a URL — refusing rather than guessing`;
  }
  if (DENY_EXACT.has(host)) return `${host} is production`;
  if (host.includes("resellsubsos-prod")) return `${host} belongs to the resellsubsos-prod project`;
  // Production Cloud Run service is "resellersos" in project 490252291080. The test
  // site is "reselleros-test-1027476185726" (different service and project), so it passes.
  // R-058 (7 Oct 2026): the STAGING service "resellersos-staging" (docs/STAGING.md — its
  // own Cloud SQL `resellersos-staging-db`, a wiped clone) shares the "resellersos-" prefix,
  // so the rule below refused it as production and the CI job could never target staging.
  // Allowed by its exact service-name prefix, checked BEFORE the production rule; the bare
  // production hosts (resellersos-<hash>-…, resellersos-490252291080.…) are still refused.
  if (host.endsWith(".run.app") && /^resellersos-staging-/.test(host)) return null;
  if (host.endsWith(".run.app") && (/^resellersos-/.test(host) || host.includes("490252291080"))) {
    return `${host} is the production Cloud Run service`;
  }
  return null;
}
