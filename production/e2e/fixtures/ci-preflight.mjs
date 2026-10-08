/**
 * ci-preflight.mjs — the first step of .github/workflows/e2e-logged-in.yml (R-058).
 *
 * Decides, from env NAMES only (never a value is printed), one of four outcomes:
 *
 *   refuse  a target URL is production  → exit 1, red. Never softened: this suite
 *           creates invoices, credit notes and salary runs and resets passwords.
 *   skip    NOTHING is configured yet   → exit 0, `configured=false`, a ::notice:: and
 *           a step-summary line that lists the secret names the owner must add.
 *           (7 Oct 2026: the old preflight went red on EVERY push to every branch
 *           because no secret was set — a permanent red X that hid real failures.)
 *   fail    SOME but not all are set    → exit 1, red. Somebody started the setup and
 *           missed one; skipping quietly would hide that forever.
 *   ok      everything set, not prod    → exit 0, `configured=true`, suite runs.
 *
 * A skip is a skip of the WHOLE job, visible as such — never a green Playwright run
 * whose specs all skipped (suite-health.spec.ts still guards that once it runs).
 *
 * Usage in CI: `node e2e/fixtures/ci-preflight.mjs` with the workflow's env mapped.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { E2E_ROLES, missingEnvFor, productionHostReason } from "./e2e-roles.mjs";

/** Staging (docs/STAGING.md) — the default target when vars.E2E_BASE_URL is not set. */
export const STAGING_BASE_URL = "https://resellersos-staging-njvk4nxhdq-as.a.run.app";

/* The code reads NEXT_PUBLIC_SUPABASE_*; the GitHub secrets are E2E_SUPABASE_* because they
   point at the TEST data plane. Print the secret name, or somebody creates a secret this
   workflow never reads. */
const SECRET_NAME = {
  NEXT_PUBLIC_SUPABASE_URL: "secrets.E2E_SUPABASE_URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "secrets.E2E_SUPABASE_ANON_KEY",
};

/** Every secret the job needs, in the order the owner should read them. */
export const REQUIRED_SECRETS = [
  "secrets.E2E_SUPABASE_URL",
  "secrets.E2E_SUPABASE_ANON_KEY",
  "secrets.E2E_SUPABASE_SERVICE_ROLE_KEY",
  ...E2E_ROLES.map((r) => `secrets.E2E_${r.toUpperCase()}_PASSWORD`),
];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ outcome: "ok" | "skip" | "fail" | "refuse", baseUrl: string, missing: string[], message: string }}
 */
export function decide(env) {
  const baseUrl = (env.E2E_BASE_URL || "").trim() || STAGING_BASE_URL;

  // Production first — even an otherwise unconfigured repo must not point at prod.
  for (const [label, value] of [
    ["vars.E2E_BASE_URL", baseUrl],
    ["secrets.E2E_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL],
  ]) {
    const reason = productionHostReason(value);
    if (reason) {
      return {
        outcome: "refuse", baseUrl, missing: [],
        message: `REFUSING: ${label} points at production — ${reason}. ` +
          "This suite creates invoices, credit notes and salary runs, and resets user passwords.",
      };
    }
  }

  const missing = [];
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("secrets.E2E_SUPABASE_SERVICE_ROLE_KEY");
  for (const name of missingEnvFor(E2E_ROLES, env)) missing.push(SECRET_NAME[name] ?? `secrets.${name}`);
  missing.sort((a, b) => REQUIRED_SECRETS.indexOf(a) - REQUIRED_SECRETS.indexOf(b));

  const list = missing.join(", ");
  if (missing.length === REQUIRED_SECRETS.length) {
    return {
      outcome: "skip", baseUrl, missing,
      message: `SKIPPED — logged-in E2E is not set up yet, nothing was tested. ` +
        `Owner must add these GitHub Actions secrets (Settings → Secrets and variables → Actions): ${list}. ` +
        `Target when set: ${baseUrl}. See production/e2e/README.md "Logged-in E2E".`,
    };
  }
  if (missing.length) {
    return {
      outcome: "fail", baseUrl, missing,
      message: `Logged-in E2E is HALF set up — ${REQUIRED_SECRETS.length - missing.length} of ` +
        `${REQUIRED_SECRETS.length} secrets present. Still missing: ${list}. ` +
        "Add them (Settings → Secrets and variables → Actions) or remove the others; a partial setup is not skipped.",
    };
  }
  return { outcome: "ok", baseUrl, missing, message: `Preflight OK — configuration present, target ${baseUrl} is not production.` };
}

function main() {
  const d = decide(process.env);
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `configured=${d.outcome === "ok"}\nbase_url=${d.baseUrl}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const icon = { ok: "✅", skip: "⏭️", fail: "❌", refuse: "⛔" }[d.outcome];
  if (summary) fs.appendFileSync(summary, `### E2E (logged-in) preflight: ${icon} ${d.outcome.toUpperCase()}\n\n${d.message}\n`);

  if (d.outcome === "ok") { console.log(d.message); return 0; }
  if (d.outcome === "skip") { console.log(`::notice title=E2E (logged-in) skipped::${d.message}`); return 0; }
  console.log(`::error title=E2E (logged-in) ${d.outcome}::${d.message}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
