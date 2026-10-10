#!/usr/bin/env node
/**
 * Are the migration FILES in a shape that can be applied in order?  (git only — no database)
 *
 *   node scripts/migration-order-check.mjs                     # base = origin/main
 *   node scripts/migration-order-check.mjs --base origin/manager-pardeep
 *   MIGRATION_BASE=<sha> node scripts/migration-order-check.mjs
 *
 * Fails (exit 1) when:
 *   1. a file in supabase/migrations/ is not `YYYYMMDDHHMMSS_snake_name.sql`;
 *   2. two files share a version (the CLI keys the ledger on the 14 digits, not the name);
 *   3. a migration that already exists on the base was EDITED, RENAMED or DELETED — it has
 *      (probably) run on production already, so the edit never reaches the database. Write a
 *      new forward migration instead;
 *   4. a migration ADDED on this branch is not newer than the newest one already on the base.
 *      `supabase db push` refuses to apply a version older than the last applied one without
 *      `--include-all`, and even with it the file runs out of order against a schema that has
 *      moved on. Regenerate its timestamp (`npm run migration:new`) and move the SQL over.
 *
 * Why (S18, Sep 2026): three people work on three long-lived branches, each writing
 * migrations. A file created on a branch on the 10th and merged on the 20th lands BEHIND
 * everything main applied in between — the "committed but never applied" state that
 * scripts/migration-drift-check.mjs found twice in August, once holding ₹8,165 of GST. That
 * script asks the live DB; this one needs no credential, so it can run in CI on every push.
 *
 * README.md and anything not ending in .sql are ignored. Base missing (shallow clone, first
 * push) → rules 3–4 are skipped with a warning; rules 1–2 always run.
 */
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const REL = "production/supabase/migrations"; // path as git sees it from the repo root
const DIR = join(APP, "supabase", "migrations");
const NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

/**
 * Rule 3 assumes an edited file has already run on production. On 2 Oct 2026 that was false
 * for the migrations written after the 8 Sep deploy (c81a9067): a rehearsal on a Cloud SQL
 * clone of production found these four fail there, and a forward migration cannot help a file
 * that stops the run before the forward one is reached. So they were fixed in place, with
 * Pardeep's approval. Staging and local already ran the old text — harmless (same FK target
 * ids; pg_trgm already installed). Named, not a pattern, so every other edit is still refused.
 * REMOVE this set once the go-live has applied them — after that rule 3 is true for them too.
 */
const NOT_YET_ON_PRODUCTION = new Set([
  "20260910100000_customer_contacts.sql", // duplicate enquiry-contact emails on real data
  "20260927250000_gbp.sql",               // FK to auth.users refused for the prod migration role
  "20260927260000_ad_platforms.sql",      // same
  "20260930110000_scale_indexes.sql",     // prod has no `extensions` schema
  "20261009220100_demo_readonly_wiring.sql", // R-531: deploy-skip, never deployed anywhere
  "20261009235000_attendance_devices.sql",   // auth.users FK refused on Cloud SQL; never reached staging/live
]);

/**
 * R-910 (10 Oct 2026): the staging → manager-pardeep merge moved these two into prisma/migrations,
 * which deleted them here; cd777ef8 put them back byte-for-byte. Re-adding an already-run file
 * under its old version is a restore, not a new out-of-order migration. Named, not a pattern.
 */
const RESTORED = new Set([
  "20261006130000_feedback_checked.sql",
  "20261006140000_undeposited_funds.sql",
]);

const argBase = (() => { const i = process.argv.indexOf("--base"); return i > 0 ? process.argv[i + 1] : null; })();
const BASE = argBase || process.env.MIGRATION_BASE || "origin/main";

const ROOT = join(APP, "..");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const problems = [];

/* ── 1 + 2: names and uniqueness, on the working tree ── */
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const seen = new Map();
for (const f of files) {
  const m = NAME.exec(f);
  if (!m) { problems.push(`bad name: ${f}  (want YYYYMMDDHHMMSS_snake_name.sql)`); continue; }
  if (seen.has(m[1])) problems.push(`duplicate version ${m[1]}: ${seen.get(m[1])} and ${f}`);
  else seen.set(m[1], f);
}

/* ── 3 + 4: against the base ── */
let baseOk = true;
let mergeBase = null;
try {
  git("rev-parse", "--verify", "--quiet", `${BASE}^{commit}`);
  mergeBase = git("merge-base", BASE, "HEAD");
} catch {
  baseOk = false;
  console.warn(`WARN: base "${BASE}" not found (shallow clone?) — skipped the edited/out-of-order checks.`);
}

if (baseOk) {
  // Newest version on the BASE branch tip (not the merge-base): a branch cut before main
  // gained a newer migration must still land after it.
  const onBase = git("ls-tree", "--name-only", `${BASE}:${REL}`).split(/\r?\n/).filter((f) => NAME.test(f));
  const newestOnBase = onBase.map((f) => NAME.exec(f)[1]).sort().at(-1) ?? "0";
  const baseSet = new Set(onBase);

  // What this branch changed since it left the base. -M so a rename shows as a rename.
  const diff = git("diff", "--name-status", "-M", `${mergeBase}`, "HEAD", "--", REL)
    .split(/\r?\n/).filter(Boolean);
  for (const line of diff) {
    const [status, a, b] = line.split("\t");
    const fa = a?.split("/").pop();
    const fb = b?.split("/").pop();
    if (!fa?.endsWith(".sql")) continue;
    const code = status[0];
    if (code === "A") {
      const v = NAME.exec(fa)?.[1];
      if (v && !baseSet.has(fa) && v <= newestOnBase && !RESTORED.has(fa))
        problems.push(`out of order: ${fa} is not newer than ${newestOnBase} (newest on ${BASE}) — regenerate its timestamp`);
    } else if (code === "M") {
      if (NOT_YET_ON_PRODUCTION.has(fa)) {
        console.log(`note: ${fa} edited — allowed, it has never run on production (see NOT_YET_ON_PRODUCTION)`);
        continue;
      }
      problems.push(`edited an existing migration: ${fa} — it has likely run already; write a new forward migration`);
    } else if (code === "D") {
      problems.push(`deleted an existing migration: ${fa}`);
    } else if (code === "R") {
      problems.push(`renamed an existing migration: ${fa} -> ${fb}`);
    }
  }
  console.log(`base ${BASE} (merge-base ${mergeBase.slice(0, 8)}), newest there ${newestOnBase}, ${diff.length} migration change(s) on this branch`);
}

console.log(`${files.length} migration files checked`);
if (problems.length) {
  console.error("\nMigration check FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("migrations OK");
