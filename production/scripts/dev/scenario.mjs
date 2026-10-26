#!/usr/bin/env node
/**
 * scenario.mjs — one-click LOCAL test scenarios for the money / reconcile cards (R-1957).
 *
 *   node scripts/dev/scenario.mjs                      list the scenarios
 *   node scripts/dev/scenario.mjs <name> [--reset]     (re)load one: its old rows go, fresh rows come
 *   node scripts/dev/scenario.mjs all                  (re)load every scenario
 *   node scripts/dev/scenario.mjs <name|all> --clear   remove that scenario's rows only
 *   node scripts/dev/scenario.mjs --self-test          load each twice + clear, ROLLED BACK; checks counts
 *   … --host tester1.localhost:3008                    host for the printed URLs (default localhost:3001)
 *
 * Run from production/. Writes into "E2E Test Co" (the company localhost:3001 signs into) in the
 * local docker DB (supabase_db_*), through psql inside that container, one transaction per run.
 * Every load first removes what the scenario made before (fixed ids, bill no "SCN-…", and what the
 * app built from its lines), so running it again never duplicates — `--reset` says it explicitly.
 *
 * REFUSES (exit 1) — hard-coded, no override — when NODE_ENV is production, when no local
 * Supabase DB container runs, or when any Supabase / database URL in the env or .env.local is not
 * local (the app would not be reading the docker DB). Prints names, counts and URLs only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { scenarioTargetReason, appHostLocalReason } from "./local-guard.mjs";
import { SCENARIOS, SCENARIO_NAMES, SCN_ACCOUNT_ID, pageUrl, sqlTextArray } from "./scenarios/index.mjs";
import { E2E_TENANT_EMAIL, E2E_TENANT_NAME } from "../../e2e/fixtures/e2e-roles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const productionDir = resolve(here, "..", "..");
const scenarioDir = join(here, "scenarios");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function die(msg) {
  console.error(`scenario: ${msg}`);
  process.exit(1);
}

/* ── args ── */
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
let host = "localhost:3001";
const hostAt = argv.indexOf("--host");
if (hostAt >= 0) host = argv[hostAt + 1] ?? "";
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--host");
const target = positional[0];

if (!target && !flags.has("--self-test")) {
  console.log("Scenarios (node scripts/dev/scenario.mjs <name> [--reset | --clear]):\n");
  for (const s of SCENARIOS) console.log(`  ${s.name.padEnd(16)} ${s.cards.join(", ").padEnd(40)} ${s.about}\n`);
  console.log("  all              every scenario above\n  --self-test      load each twice + clear in a rolled-back transaction");
  process.exit(0);
}
const hostWhy = appHostLocalReason(host);
if (hostWhy) die(hostWhy);
const picked = flags.has("--self-test") || target === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.name === target);
if (!picked.length) die(`unknown scenario "${target}" — one of: ${SCENARIO_NAMES.join(", ")}, all`);

/* ── guard: local docker DB only ── */
function envLocal() {
  const f = join(productionDir, ".env.local");
  if (!existsSync(f)) return {};
  const out = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const fileEnv = envLocal();
const URL_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
const container = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
const why = scenarioTargetReason({
  nodeEnv: process.env.NODE_ENV,
  container,
  urls: URL_KEYS.flatMap((k) => [process.env[k], fileEnv[k]]),
});
if (why) die(why);

/* ── psql inside the container ── */
function psql(sql) {
  const r = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) die(`psql failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const tenants = psql(`select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
if (!tenants.length) die(`"${E2E_TENANT_NAME}" not found — run E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first.`);
if (tenants.length > 1) die(`${tenants.length} companies carry ${E2E_TENANT_EMAIL}; fix by hand first.`);
const tenantId = tenants[0].trim();
if (!UUID.test(tenantId)) die("tenant id is not a uuid");

const common = readFileSync(join(scenarioDir, "_common.sql"), "utf8");
const header = [
  `\\set tenant '${tenantId}'`,
  `\\set acct '${SCN_ACCOUNT_ID}'`,
  "begin;",
  `select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);`,
  common,
].join("\n");

const scopeArgs = (s) =>
  [
    `'${tenantId}'::uuid`,
    `${sqlTextArray(s.scope.vendors)}::uuid[]`,
    `${sqlTextArray(s.scope.txns)}::uuid[]`,
    sqlTextArray(s.scope.docs),
    s.scope.names.length ? sqlTextArray(s.scope.names) : "'{}'::text[]",
    s.scope.upis.length ? sqlTextArray(s.scope.upis) : "'{}'::text[]",
  ].join(", ");
const clearSql = (s, tag) => `select 'SCN|${tag}|${s.name}|' || pg_temp.scn_clear(${scopeArgs(s)})::text;`;
const countSql = (s, tag) => `select 'SCN|${tag}|${s.name}|' || pg_temp.scn_count(${scopeArgs(s)})::text;`;
const loadSql = (s) => readFileSync(join(scenarioDir, `${s.name}.sql`), "utf8") + "\n";

/** The tester's app steps, as the E2E owner (the money RPCs check the caller's role). */
const asOwner = (sql) => [
  "select set_config('request.jwt.claims', json_build_object('sub', (select u.id from public.users u where u.tenant_id = :'tenant' and u.role = 'owner' order by u.created_at limit 1), 'role', 'authenticated')::text, true);",
  sql,
  "select set_config('request.jwt.claims', '', true);",
].join("\n");

/** Counts equal to what the scenario expects (jsonb does not keep key order). */
const sameCounts = (got, want) =>
  !!got && Object.keys(want).length === Object.keys(got).length && Object.entries(want).every(([k, v]) => got[k] === v);

/** Parsed "SCN|tag|name|{json}" lines. */
function results(lines) {
  return lines
    .filter((l) => l.startsWith("SCN|"))
    .map((l) => {
      const [, tag, name, ...rest] = l.split("|");
      return { tag, name, data: JSON.parse(rest.join("|")) };
    });
}

/* ── --self-test: every scenario loaded twice and cleared, in one rolled-back transaction ── */
if (flags.has("--self-test")) {
  const parts = [header];
  for (const s of SCENARIOS) {
    parts.push(clearSql(s, "pre"), loadSql(s), countSql(s, "load1"), asOwner(s.selfTestUse ?? ""), countSql(s, "used"),
      clearSql(s, "reset"), loadSql(s), countSql(s, "load2"));
  }
  for (const s of SCENARIOS) parts.push(clearSql(s, "clear"), countSql(s, "after-clear"));
  parts.push("rollback;");
  const rs = results(psql(parts.join("\n")));
  let bad = 0;
  for (const s of SCENARIOS) {
    const get = (tag) => rs.find((r) => r.name === s.name && r.tag === tag)?.data;
    const l1 = get("load1"), used = get("used"), l2 = get("load2"), gone = get("after-clear");
    const same = sameCounts(l1, s.expect) && sameCounts(l2, s.expect);
    const empty = gone && Object.entries(gone).every(([, v]) => v === 0);
    console.log(`${same && empty ? "✓" : "✗"} ${s.name}: load ${JSON.stringify(l1)} · after app steps ${JSON.stringify(used)} · reset+reload ${JSON.stringify(l2)} · after clear ${JSON.stringify(gone)}`);
    if (!same) console.log(`    expected ${JSON.stringify(s.expect)}`);
    if (!same || !empty) bad++;
  }
  console.log(bad ? `\n${bad} scenario(s) wrong — nothing kept (rolled back).` : "\nAll scenarios load, reload without duplicates and clear to zero (rolled back — nothing kept).");
  process.exit(bad ? 1 : 0);
}

/* ── load / reset / clear ── */
const clearOnly = flags.has("--clear");
const parts = [header];
for (const s of picked) {
  parts.push(clearSql(s, "cleared"));
  if (!clearOnly) parts.push(loadSql(s), countSql(s, "loaded"));
}
parts.push("commit;");
const rs = results(psql(parts.join("\n")));

console.log(`${E2E_TENANT_NAME} (${tenantId}) · local DB ${container}\n`);
for (const s of picked) {
  const cleared = rs.find((r) => r.name === s.name && r.tag === "cleared")?.data ?? {};
  const removed = Object.values(cleared).reduce((a, b) => a + b, 0);
  console.log(`■ ${s.name} — for ${s.cards.join(", ")}`);
  console.log(`  ${removed ? `removed the earlier rows (${JSON.stringify(cleared)})` : "no earlier rows"}`);
  if (clearOnly) { console.log(""); continue; }
  const loaded = rs.find((r) => r.name === s.name && r.tag === "loaded")?.data;
  const ok = sameCounts(loaded, s.expect);
  console.log(`  ${ok ? "✓" : "✗"} loaded ${JSON.stringify(loaded)}`);
  console.log(`  ${s.about}`);
  console.log("  Open (signed in as the E2E owner):");
  for (const p of s.pages) console.log(`    ${pageUrl(host, p.path)}\n      → ${p.for}`);
  console.log("");
  if (!ok) die(`${s.name}: counts differ from ${JSON.stringify(s.expect)}`);
}
