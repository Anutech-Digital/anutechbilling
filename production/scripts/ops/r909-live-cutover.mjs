#!/usr/bin/env node
/**
 * R-909 — move LIVE (`resellersos`) off the retired Supabase VM onto the same path staging runs:
 * Auth.js + the in-app data gateway (Prisma) + Cloud Storage. Runbook: docs/R-909-LIVE-CUTOVER.md.
 *
 * DRY RUN BY DEFAULT. Without --run it only PRINTS the gcloud/git commands of a step. With --run it
 * executes them, one step per call, stopping at the first failure. Secret values are generated or
 * read in-process and handed to gcloud on stdin — never printed, never on a command line. The one
 * value printed is the live ANON key, which is public (it ships in every browser bundle).
 *
 *   node scripts/ops/r909-live-cutover.mjs                       # list the steps
 *   node scripts/ops/r909-live-cutover.mjs <step>                # print what <step> would run
 *   node scripts/ops/r909-live-cutover.mjs <step> --run          # do it (Pardeep's haan first)
 *
 * Cloud Run is changed ONLY with --update-env-vars / --update-secrets / --remove-env-vars, never
 * --set-env-vars / --set-secrets (those replace the whole set and would drop the live-only keys).
 * Database work is NOT here: scripts/ops/r909-live-db.sh (roles, migrations, fingerprint).
 */
import { spawnSync } from "node:child_process";
import { randomBytes, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const P = "resellsubsos-prod";
export const R = "asia-southeast1";
export const SERVICE = "resellersos";
export const INSTANCE = "resellersos-db";
export const CONN = `${P}:${R}:${INSTANCE}`;
export const DB = "resellersos";
export const SA = "1005662057478-compute@developer.gserviceaccount.com"; // live + staging Cloud Run SA (10 Oct, describe)
export const APP = "https://reselleros.anutech.in"; // domain mapping reselleros.anutech.in -> resellersos
export const BUCKET = "resellsubsos-live-files";
export const TRIGGER = "resellersos-deploy-on-push";
export const ROLLBACK_REVISION = "resellersos-00035-prc"; // serving 100% on 10 Oct (image resellersos:5fb1783)
export const ROLES = ["runtime", "anon", "service", "auth", "jobs"];
export const URL_SECRET = {
  runtime: ["DATABASE_URL", "live-database-url"],
  anon: ["ANON_DATABASE_URL", "live-anon-database-url"],
  service: ["SERVICE_DATABASE_URL", "live-service-database-url"],
  auth: ["AUTH_DATABASE_URL", "live-auth-database-url"],
  jobs: ["JOBS_DATABASE_URL", "live-jobs-database-url"],
};
// 15 jobs in asia-southeast1 pointing at the live run.app URL (gcloud scheduler jobs list, 10 Oct).
export const CRON_JOBS = [
  "renewals", "health-digest", "gmail-inbox", "billing", "attendance-retention", "invoice-dunning",
  "ai-reply-retry", "birthday-greetings", "mrr-snapshot", "ai-reflection", "attendance-reminders",
  "compliance-reminders", "trial-expiry", "backup", "google-contacts-sync",
].map((j) => `resellersos-${j}`);

export const ENV_UPDATES = {
  DATA_GATEWAY: "1",
  AUTH_PROVIDER: "authjs",
  AUTH_URL: APP,
  STORAGE_BACKEND: "gcs",
  GCS_BUCKET: BUCKET,
  DB_POOL_MAX: "3",
  NEXT_PUBLIC_APP_URL: APP, // live has the stale asia-south1 URL (…-el.a.run.app) today
};
export const SECRET_UPDATES = {
  ...Object.fromEntries(Object.values(URL_SECRET)),
  SUPABASE_JWT_SECRET: "live-supabase-jwt-secret",
  AUTH_SECRET: "live-auth-secret",
};

/** HS256 key exactly as setup-staging-secrets.sh mints them (role anon / service_role, 10 years). */
export function mintKey(role, jwtSecret, nowSec = Math.floor(Date.now() / 1000)) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" });
  const p = b({ role, iss: "supabase", iat: nowSec, exp: nowSec + 10 * 365 * 86400 });
  return `${h}.${p}.${createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest("base64url")}`;
}

export function dbUrl(role, password) {
  return `postgresql://app_${role}:${password}@localhost/${DB}?host=/cloudsql/${CONN}`;
}

export function runEnvArgs() {
  return [
    "run", "services", "update", SERVICE, `--project=${P}`, `--region=${R}`, "--no-traffic", "--tag=r909",
    "--memory=1Gi",
    `--update-env-vars=${Object.entries(ENV_UPDATES).map(([k, v]) => `${k}=${v}`).join(",")}`,
    `--update-secrets=${Object.entries(SECRET_UPDATES).map(([k, v]) => `${k}=${v}:latest`).join(",")}`,
  ];
}

/** Adds/overwrites substitution lines in an exported trigger YAML (text edit, like r161-step4b-trigger.sh). */
export function withSubstitutions(yamlText, subs) {
  const lines = yamlText.replace(/\r/g, "").split("\n").filter((l) => !Object.keys(subs).some((k) => l.startsWith(`  ${k}:`)));
  const block = Object.entries(subs).map(([k, v]) => `  ${k}: '${String(v).replace(/'/g, "''")}'`);
  const i = lines.findIndex((l) => l === "substitutions:" || l === "substitutions: {}");
  if (i >= 0) lines.splice(i, 1, "substitutions:", ...block);
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("substitutions:", ...block, "");
  }
  return lines.join("\n");
}

// ─── execution ──────────────────────────────────────────────────────────────
const RUN = process.argv.includes("--run");
const isWin = process.platform === "win32";
const q = (a) => (/[\s"&|<>^;]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function gcloud(args, { input, capture = false, secretInput = false, allowFail = false } = {}) {
  const shown = `gcloud ${args.map(q).join(" ")}${input !== undefined ? (secretInput ? "   <- value on stdin (generated in-process, not shown)" : "   <- stdin") : ""}`;
  if (!RUN) { console.log(`  [dry-run] ${shown}`); return ""; }
  console.log(`  $ ${shown}`);
  const r = spawnSync(isWin ? "gcloud.cmd" : "gcloud", isWin ? args.map(q) : args, {
    input, encoding: "utf8", shell: isWin, stdio: [input !== undefined ? "pipe" : "inherit", capture ? "pipe" : "inherit", "inherit"],
  });
  if (r.status !== 0 && !allowFail) { console.error(`\nSTOPPED: command failed (exit ${r.status}). Nothing after it ran. Send Claude this screen.`); process.exit(1); }
  return capture ? (r.stdout ?? "").trim() : "";
}

function putSecret(name, value) {
  const exists = RUN ? spawnSync(isWin ? "gcloud.cmd" : "gcloud", ["secrets", "describe", name, `--project=${P}`], { shell: isWin, stdio: "ignore" }).status === 0 : false;
  if (exists) gcloud(["secrets", "versions", "add", name, `--project=${P}`, "--data-file=-"], { input: value, secretInput: true });
  else gcloud(["secrets", "create", name, `--project=${P}`, "--replication-policy=automatic", "--data-file=-"], { input: value, secretInput: true });
  gcloud(["secrets", "add-iam-policy-binding", name, `--project=${P}`, `--member=serviceAccount:${SA}`, "--role=roles/secretmanager.secretAccessor", "--condition=None", "--quiet"], { capture: true });
}
const readSecret = (name) => gcloud(["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${P}`], { capture: true });

const STEPS = {
  check: {
    about: "read-only: account, live service env NAMES, live-* secrets, trigger, scheduler state",
    run() {
      gcloud(["config", "get-value", "account"]);
      gcloud(["run", "services", "describe", SERVICE, `--project=${P}`, `--region=${R}`, "--format=value(status.traffic,spec.template.spec.containers[0].env[].name)"]);
      gcloud(["secrets", "list", `--project=${P}`, "--filter=name~^live-", "--format=value(name)"]);
      gcloud(["builds", "triggers", "describe", TRIGGER, `--project=${P}`, "--format=yaml(github,substitutions,filename)"]);
      gcloud(["scheduler", "jobs", "list", `--project=${P}`, `--location=${R}`, "--format=table(name.basename(),state,httpTarget.uri)"]);
    },
  },
  secrets: {
    about: "create live-* secrets: JWT secret, service_role + anon keys, AUTH_SECRET, 5 DB URLs (needs r909-live-db.sh roles step done on resellersos-db first)",
    run() {
      for (const r of ROLES) if (RUN && !readSecret(`live-db-app-${r}-password`)) { console.error(`live-db-app-${r}-password is missing — run scripts/ops/r909-live-db.sh on resellersos-db first.`); process.exit(1); }
      const jwt = randomBytes(32).toString("hex");
      putSecret("live-supabase-jwt-secret", jwt);
      putSecret("live-service-role-key", mintKey("service_role", jwt));
      const anon = mintKey("anon", jwt);
      putSecret("live-anon-key", anon);
      putSecret("live-auth-secret", randomBytes(32).toString("base64"));
      for (const r of ROLES) {
        const pw = RUN ? readSecret(`live-db-app-${r}-password`) : "<from live-db-app-" + r + "-password>";
        putSecret(URL_SECRET[r][1], dbUrl(r, pw));
      }
      if (RUN) console.log(`\nLive ANON key (public — goes into the deploy trigger as _SUPABASE_ANON_KEY):\n${anon}`);
    },
  },
  bucket: {
    about: `create gs://${BUCKET} (private, uniform access, like resellsubsos-staging-files) + objectAdmin for the Cloud Run SA`,
    run() {
      gcloud(["storage", "buckets", "create", `gs://${BUCKET}`, `--project=${P}`, `--location=${R}`, "--uniform-bucket-level-access", "--public-access-prevention", "--default-storage-class=STANDARD"]);
      gcloud(["storage", "buckets", "add-iam-policy-binding", `gs://${BUCKET}`, `--member=serviceAccount:${SA}`, "--role=roles/storage.objectAdmin"]);
    },
  },
  "scheduler-pause": {
    about: "pause the 15 live cron jobs (gmail-inbox runs every minute) for the cutover window",
    run() { for (const j of CRON_JOBS) gcloud(["scheduler", "jobs", "pause", j, `--project=${P}`, `--location=${R}`]); },
  },
  "scheduler-resume": {
    about: "resume the 15 live cron jobs (after the app is verified)",
    run() { for (const j of CRON_JOBS) gcloud(["scheduler", "jobs", "resume", j, `--project=${P}`, `--location=${R}`]); },
  },
  "run-env": {
    about: "Cloud Run live: new env + secrets + 1Gi on a NO-TRAFFIC revision tagged r909 (old image, so nothing changes for users)",
    run() {
      gcloud(runEnvArgs());
      // SUPABASE_SERVICE_ROLE_KEY is a PLAIN env var on live today; Cloud Run will not turn a plain
      // var into a secret in place, so remove it, then add it back from Secret Manager. Both no-traffic.
      gcloud(["run", "services", "update", SERVICE, `--project=${P}`, `--region=${R}`, "--no-traffic", "--tag=r909", "--remove-env-vars=SUPABASE_SERVICE_ROLE_KEY"]);
      gcloud(["run", "services", "update", SERVICE, `--project=${P}`, `--region=${R}`, "--no-traffic", "--tag=r909", "--update-secrets=SUPABASE_SERVICE_ROLE_KEY=live-service-role-key:latest"]);
    },
  },
  trigger: {
    about: `deploy trigger ${TRIGGER}: browser switches on + live anon key (export -> edit -> import; backup yaml kept)`,
    run() {
      const dir = RUN ? mkdtempSync(join(tmpdir(), "r909-trigger-")) : join(tmpdir(), "r909-trigger-XXXX");
      const before = join(dir, "trigger-before.yaml"), after = join(dir, "trigger-after.yaml");
      gcloud(["beta", "builds", "triggers", "export", TRIGGER, `--project=${P}`, `--destination=${before}`]);
      const anon = RUN ? readSecret("live-anon-key") : "<live-anon-key>";
      const subs = { _DATA_GATEWAY: "1", _AUTH_PROVIDER: "authjs", _SUPABASE_URL: `${APP}/api/sb`, _SUPABASE_ANON_KEY: anon };
      if (RUN) {
        writeFileSync(after, withSubstitutions(readFileSync(before, "utf8"), subs));
        console.log(`  backup of the trigger as it was: ${before}  (rollback: gcloud beta builds triggers import --project=${P} --source=<that file>)`);
      } else console.log(`  [dry-run] write ${after} = before + substitutions ${JSON.stringify({ ...subs, _SUPABASE_ANON_KEY: "<live anon key>" })}`);
      gcloud(["beta", "builds", "triggers", "import", `--project=${P}`, `--source=${after}`]);
      gcloud(["builds", "triggers", "describe", TRIGGER, `--project=${P}`, "--format=value(substitutions._DATA_GATEWAY,substitutions._AUTH_PROVIDER,substitutions._SUPABASE_URL)"]);
    },
  },
  deploy: {
    about: "push the verified staging commit to branch `deploy` (fast-forward; Cloud Build builds + deploys)",
    run() {
      const sha = (process.argv.find((a) => a.startsWith("--sha=")) ?? "").slice(6);
      if (!/^[0-9a-f]{7,40}$/.test(sha)) { console.log("  needs --sha=<staging commit that passed the staging check>"); if (RUN) process.exit(1); }
      const cmd = ["push", "anutech", `${sha || "<sha>"}:refs/heads/deploy`];
      if (!RUN) { console.log(`  [dry-run] git ${cmd.join(" ")}   (no --force: deploy must be an ancestor of <sha>)`); return; }
      const r = spawnSync("git", cmd, { stdio: "inherit" });
      if (r.status !== 0) process.exit(1);
      gcloud(["builds", "list", `--project=${P}`, "--limit=1", "--format=value(id,status,substitutions.BRANCH_NAME,substitutions.SHORT_SHA)"]);
    },
  },
  "tag-new": {
    about: "after the build: point tag r909 at the newest revision (still no traffic) so it can be checked at https://r909---resellersos-njvk4nxhdq-as.a.run.app",
    run() {
      const rev = RUN ? gcloud(["run", "revisions", "list", `--service=${SERVICE}`, `--project=${P}`, `--region=${R}`, "--limit=1", "--sort-by=~metadata.creationTimestamp", "--format=value(metadata.name)"], { capture: true }) : "<newest revision>";
      gcloud(["run", "services", "update-traffic", SERVICE, `--project=${P}`, `--region=${R}`, `--set-tags=r909=${rev}`]);
    },
  },
  traffic: {
    about: "send 100% of live traffic to the newest revision (the switch users feel)",
    run() { gcloud(["run", "services", "update-traffic", SERVICE, `--project=${P}`, `--region=${R}`, "--to-latest"]); },
  },
  "rollback-traffic": {
    about: `undo the switch: 100% back to ${ROLLBACK_REVISION} (the 10 Oct revision)`,
    run() { gcloud(["run", "services", "update-traffic", SERVICE, `--project=${P}`, `--region=${R}`, `--to-revisions=${ROLLBACK_REVISION}=100`]); },
  },
};

function main() {
  const step = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!step || !STEPS[step]) {
    console.log("R-909 live cutover helper — dry run unless --run.\n");
    for (const [k, s] of Object.entries(STEPS)) console.log(`  ${k.padEnd(18)} ${s.about}`);
    console.log("\nOrder and checks: docs/R-909-LIVE-CUTOVER.md");
    if (step) process.exit(1);
    return;
  }
  console.log(`== R-909 step "${step}" — ${RUN ? "RUNNING" : "DRY RUN (nothing changes; add --run)"}\n   ${STEPS[step].about}`);
  STEPS[step].run();
  console.log(RUN ? `\n== "${step}" done.` : "\n== dry run only.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
export { STEPS };
