/**
 * R-887 — prove a Cloud SQL backup can actually be restored.
 *
 * Restores the LATEST SUCCESSFUL automated/on-demand backup of <instance> into a brand-new,
 * temporary instance ("the clone"), runs READ-ONLY row counts + the migration-ledger tail on it,
 * compares them with minimums, and ALWAYS deletes the clone (finally block). The source instance is
 * only read (describe + backups list); nothing is ever written to it.
 *
 * DRY RUN BY DEFAULT: prints every gcloud/psql command it WOULD run and the cost note. Runs nothing.
 *
 *   node scripts/ops/backup-restore-test.mjs --instance=resellersos-staging-db
 *   node scripts/ops/backup-restore-test.mjs --instance=resellersos-staging-db --client-ip=<your public ip> \
 *        --run --confirm="RESTORE TEST resellersos-staging-db"
 *   options: --project=resellsubsos-prod  --min=customers=10 (repeatable)  --allow-live-source
 *
 * A real run needs --run AND the typed phrase `RESTORE TEST <instance>` (via --confirm=... or the
 * prompt). The live instance (resellersos-db) is refused unless --allow-live-source is also given.
 * The clone is billable while it exists (see costNote) — running it is Pardeep's haan.
 *
 * Why `backups restore` into a fresh instance and not `instances clone`: clone copies the source
 * via point-in-time recovery (the WAL), so it never touches a backup file. R-887 is about the
 * backups themselves.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT = "resellsubsos-prod";
export const LIVE_INSTANCE = "resellersos-db";
export const CLONE_PREFIX = "r887-restore-test-";
export const DB = "resellersos";
export const KEY_TABLES = ["tenants", "users", "customers", "invoices", "payments", "subscriptions", "employees", "activity_log"];
/** Defaults: a restore with zero tenants/users is broken. Others may be 0 (staging is wiped); raise with --min. */
export const DEFAULT_MINS = { tenants: 1, users: 1, customers: 0, invoices: 0, payments: 0, subscriptions: 0, employees: 0, activity_log: 0 };
/** Rough ₹/hour while the clone exists (asia-southeast1, Enterprise, compute + memory; storage adds little). */
export const TIER_INR_PER_HOUR = { "db-f1-micro": 2, "db-g1-small": 4, "db-custom-1-3840": 8 };
/** Known tiers (docs/STAGING.md, production/docs/R-909-LIVE-CUTOVER.md) for the dry-run plan. */
const KNOWN_TIER = { "resellersos-db": "db-custom-1-3840", "resellersos-staging-db": "db-f1-micro" };

const isWin = process.platform === "win32";
const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);

export function parseArgs(argv) {
  const o = { instance: null, project: PROJECT, run: false, confirm: null, allowLive: false, clientIp: null, mins: { ...DEFAULT_MINS }, help: false };
  for (const a of argv) {
    const [k, ...rest] = a.split("=");
    const v = rest.join("=");
    if (a === "--run") o.run = true;
    else if (a === "--allow-live-source") o.allowLive = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (k === "--instance") o.instance = v;
    else if (k === "--project") o.project = v;
    else if (k === "--confirm") o.confirm = v;
    else if (k === "--client-ip") o.clientIp = v;
    else if (k === "--min") {
      const m = /^([a-z_]+)=(\d+)$/.exec(v);
      if (!m) throw new Error(`--min wants table=N, got "${v}"`);
      o.mins[m[1]] = Number(m[2]);
    } else throw new Error(`unknown argument "${a}"`);
  }
  if (!o.help && !o.instance) throw new Error("--instance=<source Cloud SQL instance> is required");
  if (o.instance && !/^[a-z][a-z0-9-]{0,97}$/.test(o.instance)) throw new Error(`bad instance name "${o.instance}"`);
  if (o.clientIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(o.clientIp)) throw new Error(`--client-ip wants an IPv4 address, got "${o.clientIp}"`);
  return o;
}

export const phraseFor = (instance) => `RESTORE TEST ${instance}`;

export function costNote(tier) {
  const perHour = TIER_INR_PER_HOUR[tier];
  return perHour
    ? `COST: the clone (${tier}) is billable while it exists — about ₹${perHour}/hour; a run takes 30–60 min, so roughly ₹${perHour}–${perHour * 2} plus a little storage. It is deleted at the end.`
    : `COST: the clone (tier ${tier ?? "same as source"}) is billable while it exists (chhota kharcha, 30–60 min). It is deleted at the end.`;
}

export function cloneName(now = new Date()) {
  return CLONE_PREFIX + now.toISOString().replace(/[-:T]/g, "").slice(0, 12); // r887-restore-test-YYYYMMDDhhmm
}

/** One read-only statement: count(*) per key table (-1 = table missing) + the newest ledger entries. */
export function sanitySql(tables = KEY_TABLES) {
  const counts = tables.map((t) =>
    `select 'count' as k, '${t}' as name, case when to_regclass('public.${t}') is null then '-1' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.${t}', false, true, '')))[1]::text end as v`,
  );
  const ledger = [
    `select 'ledger', 'supabase_migrations', case when to_regclass('supabase_migrations.schema_migrations') is null then '' else (xpath('/row/c/text()', query_to_xml('select max(version) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text end`,
    `select 'ledger', 'prisma_migrations', case when to_regclass('public._prisma_migrations') is null then '' else (xpath('/row/c/text()', query_to_xml('select migration_name as c from public._prisma_migrations where finished_at is not null order by finished_at desc limit 1', false, true, '')))[1]::text end`,
  ];
  return [...counts, ...ledger].join("\nunion all\n") + ";";
}

/** psql -At -F'|' output → { counts: {table: n}, ledger: {name: last} } */
export function parseSanity(stdout) {
  const counts = {}, ledger = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const [k, name, v = ""] = line.split("|");
    if (k === "count") counts[name] = Number(v);
    else if (k === "ledger") ledger[name] = v.trim();
  }
  return { counts, ledger };
}

export function compare({ counts, ledger }, mins) {
  const fails = [];
  for (const [t, min] of Object.entries(mins)) {
    const n = counts[t];
    if (n === undefined || Number.isNaN(n)) fails.push(`${t}: no count returned`);
    else if (n === -1) fails.push(`${t}: table missing in the restore`);
    else if (n < min) fails.push(`${t}: ${n} rows, expected at least ${min}`);
  }
  if (!Object.values(ledger).some(Boolean)) fails.push("migration ledger: no entry in supabase_migrations.schema_migrations or _prisma_migrations");
  return fails;
}

/** Default executor: runs the binary, captures stdout. Tests inject a fake. */
function realExec(bin, args, { env } = {}) {
  const exe = isWin && bin === "gcloud" ? "gcloud.cmd" : bin;
  const r = spawnSync(exe, isWin && bin === "gcloud" ? args.map(q) : args, {
    encoding: "utf8", shell: isWin && bin === "gcloud", env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "inherit"],
  });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

async function realAsk(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/**
 * @returns exit code (0 = plan printed or restore verified; 1 = refused / failed)
 * deps: { exec(bin, args, {env}) → {status, stdout}, ask(question) → string, log, now }
 */
export async function main(argv, deps = {}) {
  const exec = deps.exec ?? realExec, ask = deps.ask ?? realAsk, log = deps.log ?? console.log, now = deps.now ?? new Date();
  let o;
  try { o = parseArgs(argv); } catch (e) { log(`ERROR: ${e.message}`); return 1; }
  if (o.help) { log("usage: backup-restore-test.mjs --instance=<src> [--project=..] [--client-ip=..] [--min=table=N] [--run --confirm=\"RESTORE TEST <src>\"] [--allow-live-source]"); return 0; }

  if (o.instance === LIVE_INSTANCE && !o.allowLive) {
    log(`REFUSED: ${LIVE_INSTANCE} is the LIVE instance. Add --allow-live-source to restore its backup into a clone (the source is only read, never written).`);
    return 1;
  }

  const P = `--project=${o.project}`;
  const clone = cloneName(now);
  const ip = o.clientIp ?? "<your public IPv4>";
  const show = (bin, args, note = "") => log(`  ${o.run ? "$" : "[dry-run]"} ${bin} ${args.map(q).join(" ")}${note}`);
  const gcloud = (args, { note = "", mustPass = true } = {}) => {
    show("gcloud", args, note);
    if (!o.run) return "";
    const r = exec("gcloud", args);
    if (r.status !== 0 && mustPass) throw new Error(`gcloud ${args.slice(0, 3).join(" ")} failed (exit ${r.status})`);
    return r.stdout;
  };

  if (!o.run) {
    log(`== R-887 backup restore test — DRY RUN (nothing runs; add --run)\n   source: ${o.instance} (${o.project}) — only read`);
    log(`   ${costNote(KNOWN_TIER[o.instance])}`);
  } else {
    if (!o.clientIp) { log("REFUSED: --client-ip=<your public IPv4> is needed so only this machine can reach the clone."); return 1; }
    const typed = o.confirm ?? (await ask(`Type "${phraseFor(o.instance)}" to create a billable clone: `));
    if (typed !== phraseFor(o.instance)) { log(`REFUSED: confirmation phrase did not match "${phraseFor(o.instance)}". Nothing was created.`); return 1; }
    log(`== R-887 backup restore test — RUNNING on ${o.instance} (${o.project}); clone = ${clone}`);
  }

  // 1. Read the source (read-only).
  const desc = gcloud(["sql", "instances", "describe", o.instance, P, "--format=value(databaseVersion,settings.tier,region,settings.dataDiskSizeGb,settings.edition)"]);
  const [version = "<databaseVersion>", tier = KNOWN_TIER[o.instance] ?? "<tier>", region = "<region>", disk = "<diskGb>", edition = "<edition>"] = o.run ? desc.split(/\s+/) : [];
  if (o.run) log(`   ${costNote(tier)}`);
  const backupLine = gcloud(["sql", "backups", "list", `--instance=${o.instance}`, P, "--filter=status=SUCCESSFUL", "--limit=1", "--format=value(id,windowStartTime)"]);
  const [backupId = "<latest backup id>", backupAt = "?"] = o.run ? backupLine.split(/\s+/) : [];
  if (o.run && !/^\d+$/.test(backupId)) { log("FAILED: no SUCCESSFUL backup found for the source. Nothing was created."); return 1; }
  if (o.run) log(`   latest successful backup: ${backupId} taken ${backupAt}`);

  const password = o.run ? randomBytes(24).toString("base64url") : "<generated>";
  let created = false, code = 1;
  try {
    // 2. Fresh instance, same version/tier/edition/disk; public IP open only to --client-ip; no backups, no deletion protection.
    created = true; // set before the call: a half-created instance must still be deleted
    gcloud(["sql", "instances", "create", clone, P, `--region=${region}`, `--database-version=${version}`, `--tier=${tier}`, `--edition=${edition}`,
      `--storage-size=${disk}`, "--no-backup", "--no-deletion-protection", "--assign-ip", `--authorized-networks=${ip}/32`, "--labels=purpose=r887-restore-test"]);
    // 3. Restore the backup INTO the clone (overwrites the clone only; --backup-instance names the source).
    gcloud(["sql", "backups", "restore", backupId, `--restore-instance=${clone}`, `--backup-instance=${o.instance}`, P, "--quiet"]);
    // 4. Throwaway password on the clone's postgres user (the clone is deleted below). Never printed.
    show("gcloud", ["sql", "users", "set-password", "postgres", `--instance=${clone}`, P, "--password=<generated, not shown>"]);
    if (o.run && exec("gcloud", ["sql", "users", "set-password", "postgres", `--instance=${clone}`, P, `--password=${password}`]).status !== 0) throw new Error("set-password on the clone failed");
    const host = gcloud(["sql", "instances", "describe", clone, P, "--format=value(ipAddresses[0].ipAddress)"]) || "<clone ip>";
    // 5. Read-only sanity queries.
    const psqlArgs = [`host=${host} port=5432 dbname=${DB} user=postgres sslmode=require`, "-At", "-F|", "-v", "ON_ERROR_STOP=1", "-c", sanitySql()];
    log(`  ${o.run ? "$" : "[dry-run]"} psql "host=${host} … sslmode=require" -At -F'|' -c <read-only count(*) on ${KEY_TABLES.join(", ")} + ledger tail>   (PGPASSWORD on env, PGOPTIONS default_transaction_read_only=on)`);
    if (!o.run) { log("\n   expected minimums: " + Object.entries(o.mins).map(([t, n]) => `${t}≥${n}`).join(", ")); code = 0; return code; }
    const r = exec("psql", psqlArgs, { env: { PGPASSWORD: password, PGOPTIONS: "-c default_transaction_read_only=on", PGCONNECT_TIMEOUT: "20" } });
    if (r.status !== 0) throw new Error(`sanity queries failed on the clone (psql exit ${r.status})`);
    const res = parseSanity(r.stdout);
    for (const t of KEY_TABLES) log(`   ${t.padEnd(14)} ${res.counts[t] === -1 ? "MISSING" : res.counts[t]}  (min ${o.mins[t] ?? 0})`);
    log(`   ledger: supabase_migrations=${res.ledger.supabase_migrations || "-"}  prisma=${res.ledger.prisma_migrations || "-"}`);
    const fails = compare(res, o.mins);
    if (fails.length) { log("RESULT: FAIL\n  - " + fails.join("\n  - ")); code = 1; }
    else { log(`RESULT: PASS — backup ${backupId} (${backupAt}) of ${o.instance} restores and reads back.`); code = 0; }
    return code;
  } catch (e) {
    log(`FAILED: ${e.message}`);
    return 1;
  } finally {
    // 6. Always delete the clone. Name guard: never delete anything that is not ours.
    const del = ["sql", "instances", "delete", clone, P, "--quiet"];
    if (!clone.startsWith(CLONE_PREFIX)) log(`  NOT deleting "${clone}" (not an R-887 clone name)`);
    else if (!o.run) show("gcloud", del, "   (always, in finally)");
    else if (created) {
      show("gcloud", del);
      let ok = false;
      try { ok = exec("gcloud", del).status === 0; } catch { ok = false; }
      if (ok) log(`   clone ${clone} deleted.`);
      else log(`\n!! CLONE NOT DELETED — it keeps costing money. Run this now:\n   gcloud ${del.join(" ")}`);
    }
    if (!o.run) log("\n== dry run only.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
