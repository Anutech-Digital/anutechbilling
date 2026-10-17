#!/usr/bin/env node
/**
 * R-1462 — live/staging Cloud Run env + secret wiring, PRINT ONLY (R-909 blocker 9, cutover 18 Oct).
 *
 * Reads NOTHING from Google Cloud. From the checked-in map scripts/ops/live-env-map.json
 * (env var NAME → Secret Manager secret NAME, or a plain non-secret value; runbook
 * docs/R-909-LIVE-CUTOVER.md sections 2.1–2.3 + 3) it prints the exact gcloud lines Pardeep
 * pastes himself. Secret VALUES never appear anywhere — only names, so the output is safe to
 * paste in chat or a card.
 *
 *   node scripts/ops/live-env-commands.mjs                       # plan for live (default)
 *   node scripts/ops/live-env-commands.mjs --env staging          # same, staging service/secret names
 *   node scripts/ops/live-env-commands.mjs --diff <describe.yaml> # compare NAMES against a saved
 *        `gcloud run services describe <service> --region=… --project=… --format=yaml > describe.yaml`
 *        (Pardeep runs that and saves the file; this script never runs gcloud)
 *
 * There is NO apply mode. --run / --apply / --execute are refused. The script does not import
 * the module that runs other programs; a test keeps it that way.
 *
 * Cloud Run is only ever changed with --update-env-vars / --update-secrets / --remove-env-vars,
 * never --set-* (those replace the whole set and drop the live-only keys of section 2.2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAP_FILE = join(HERE, "live-env-map.json");
const FORBIDDEN = ["--run", "--apply", "--execute", "--yes", "-y"];

export function loadMap(file = MAP_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function parseArgs(argv) {
  const out = { env: "live", diff: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN.includes(a)) throw new Error(`${a}: this script only prints. Paste the lines yourself (R-1462).`);
    if (a === "--env") { out.env = argv[++i]; continue; }
    if (a.startsWith("--env=")) { out.env = a.slice(6); continue; }
    if (a === "--diff") { out.diff = argv[++i]; continue; }
    if (a.startsWith("--diff=")) { out.diff = a.slice(7); continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    throw new Error(`unknown argument ${a}`);
  }
  if (!["live", "staging"].includes(out.env)) throw new Error(`--env must be live or staging, got ${out.env}`);
  if (out.diff !== null && !out.diff) throw new Error("--diff needs a file path");
  return out;
}

/** Fill `{prefix}` / `{appUrl}` / `{bucket}` for one env; returns {env, cfg, vars, keep, googleOAuth}. */
export function resolveEnv(map, envName) {
  const cfg = map.envs[envName];
  if (!cfg) throw new Error(`no env "${envName}" in map`);
  const fill = (s) => String(s).replace("{prefix}", cfg.secretPrefix).replace("{appUrl}", cfg.appUrl).replace("{bucket}", cfg.bucket);
  const vars = map.vars.map((v) => ({ ...v, ...(v.kind === "secret" ? { secret: fill(v.secret) } : { value: fill(v.value) }) }));
  for (const v of vars) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.name)) throw new Error(`bad env name in map: ${v.name}`);
    if (v.kind === "secret" && !/^[a-z][a-z0-9-]*$/.test(v.secret)) throw new Error(`bad secret name in map for ${v.name}`);
    if (v.kind === "plain" && /[,=\s]/.test(v.value)) throw new Error(`plain value for ${v.name} must not contain , = or spaces`);
  }
  return { env: envName, cfg, vars, keep: map.keep.names, googleOAuth: map.googleOAuth };
}

const base = (cfg) => ["gcloud run services update", cfg.service, `--region=${cfg.region}`, `--project=${cfg.project}`, ...(cfg.updateFlags ?? [])].join(" ");

/** The plan, as lines. Pure: no I/O. */
export function planLines(r) {
  const { cfg, vars } = r;
  const secrets = vars.filter((v) => v.kind === "secret" && !v.optional && !v.removePlainFirst);
  const plain = vars.filter((v) => v.kind === "plain" && !v.optional);
  const twoStep = vars.filter((v) => v.removePlainFirst && !v.optional);
  const optional = vars.filter((v) => v.optional);
  const L = [];
  L.push(`# R-1462 env plan — env=${r.env} service=${cfg.service} region=${cfg.region} project=${cfg.project}`);
  L.push(`# names only; nothing was read from Google Cloud. Paste each line yourself; check with --diff after.`);
  L.push(`# (a) secrets -> env (${secrets.length} names, runbook 2.1)`);
  L.push(`${base(cfg)} --update-secrets=${secrets.map((v) => `${v.name}=${v.secret}:latest`).join(",")}`);
  L.push(`# (b) plain env vars (${plain.length} names, runbook 2.1 + 2.3)`);
  L.push(`${base(cfg)} --update-env-vars=${plain.map((v) => `${v.name}=${v.value}`).join(",")}`);
  for (const v of twoStep) {
    L.push(`# (b2) ${v.name}: ${v.note ?? "plain today -> remove, then add from Secret Manager"} (runbook 2.3)`);
    L.push(`${base(cfg)} --remove-env-vars=${v.name}`);
    L.push(`${base(cfg)} --update-secrets=${v.name}=${v.secret}:latest`);
  }
  if (cfg.memory) {
    L.push(`# (b3) memory (runbook 2.1 last row)`);
    L.push(`${base(cfg)} --memory=${cfg.memory}`);
  }
  L.push(`# (c) Google OAuth checklist (runbook section ${r.googleOAuth.section}) — console, by hand:`);
  L.push(`#     redirect URI : ${cfg.appUrl}${r.googleOAuth.redirectPath}`);
  L.push(`#     JS origin    : ${cfg.appUrl}`);
  L.push(`#     ${r.googleOAuth.note}`);
  for (const v of optional) {
    L.push(`# (d) OPTIONAL — ${v.name}: ${v.note ?? ""}`);
    L.push(`#   ${base(cfg)} --update-secrets=${v.name}=${v.secret}:latest`);
  }
  L.push(`# keep as-is (runbook 2.2, ${r.keep.length} names): ${r.keep.join(", ")}`);
  L.push(`# never --set-env-vars / --set-secrets. Verify: gcloud run services describe ${cfg.service} --region=${cfg.region} --project=${cfg.project} --format=yaml > describe.yaml && node scripts/ops/live-env-commands.mjs --env ${r.env} --diff describe.yaml`);
  return L;
}

/**
 * Minimal reader for `gcloud run services describe --format=yaml`: the container env list.
 * Returns Map<envName, {kind:"plain"} | {kind:"secret", secret, version}>. Plain VALUES are
 * dropped on purpose — they are never kept or printed.
 */
export function parseDescribeYaml(text) {
  const env = new Map();
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    let m;
    if ((m = /^\s*-\s+name:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(line))) { cur = { name: m[1], entry: null, inSecret: false }; continue; }
    if (!cur) continue;
    if (/^\s*value:/.test(line)) { cur.entry = { kind: "plain" }; }
    else if (/^\s*valueFrom:\s*$/.test(line)) { cur.entry = { kind: "secret", secret: null, version: null }; }
    else if (/^\s*secretKeyRef:\s*$/.test(line)) { cur.inSecret = true; }
    else if (cur.inSecret && (m = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))) { cur.entry.secret = m[1]; }
    else if (cur.inSecret && (m = /^\s*key:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))) { cur.entry.version = m[1]; }
    else if (/^\s*[A-Za-z]/.test(line) && !/^\s*(value|valueFrom|secretKeyRef|name|key):/.test(line)) { cur.inSecret = false; }
    if (cur.entry && /^[A-Z][A-Z0-9_]*$/.test(cur.name)) env.set(cur.name, cur.entry);
  }
  return env;
}

/** Names-only diff. plan = resolveEnv(); described = parseDescribeYaml(). */
export function diffEnv(plan, described) {
  const out = { ok: [], missing: [], wrongSecret: [], plainShouldBeSecret: [], secretShouldBePlain: [], extra: [], keepMissing: [], notLatest: [] };
  const wanted = new Set();
  for (const v of plan.vars) {
    if (v.optional) continue;
    wanted.add(v.name);
    const d = described.get(v.name);
    if (!d) { out.missing.push(v.name); continue; }
    if (v.kind === "secret") {
      if (d.kind !== "secret") { out.plainShouldBeSecret.push(v.name); continue; }
      if (d.secret !== v.secret) { out.wrongSecret.push(`${v.name}: has ${d.secret ?? "?"}, map says ${v.secret}`); continue; }
      if (d.version && d.version !== "latest") out.notLatest.push(`${v.name} (version ${d.version})`);
      out.ok.push(v.name);
    } else {
      if (d.kind !== "plain") { out.secretShouldBePlain.push(v.name); continue; }
      out.ok.push(v.name);
    }
  }
  const keep = new Set(plan.keep);
  for (const k of plan.keep) if (!described.has(k)) out.keepMissing.push(k);
  const optional = new Set(plan.vars.filter((v) => v.optional).map((v) => v.name));
  for (const name of described.keys()) if (!wanted.has(name) && !keep.has(name) && !optional.has(name)) out.extra.push(name);
  return out;
}

export function diffIsClean(d) {
  return !d.missing.length && !d.plainShouldBeSecret.length && !d.secretShouldBePlain.length && !d.wrongSecret.length;
}

export function diffLines(plan, d) {
  const L = [`# R-1462 env diff — env=${plan.env} service=${plan.cfg.service} (names only; plain values were not read)`];
  const sec = (title, arr, hint) => { if (arr.length) { L.push(`${title} (${arr.length})${hint ? " — " + hint : ""}`); for (const x of arr) L.push(`  ${x}`); } };
  sec("MISSING on the service", d.missing, "run the plan line (a)/(b) for these");
  sec("PLAIN but map says secret", d.plainShouldBeSecret, "--remove-env-vars then --update-secrets (runbook 2.3)");
  sec("SECRET but map says plain", d.secretShouldBePlain, "--remove-secrets then --update-env-vars");
  sec("DIFFERENT secret name", d.wrongSecret, "--update-secrets with the map's name");
  sec("not pinned to :latest", d.notLatest);
  sec("KEEP list (2.2) names not found", d.keepMissing, "expected on live; on staging this is normal");
  sec("EXTRA names (not in map, not in keep list)", d.extra, "decide: keep or --remove-env-vars/--remove-secrets");
  L.push(`OK: ${d.ok.length} of ${plan.vars.filter((v) => !v.optional).length} mapped names already match.`);
  L.push(diffIsClean(d) ? "RESULT: service matches the map." : "RESULT: not yet — paste the lines above from the plan.");
  return L;
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const a = parseArgs(argv);
  if (a.help) { log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); return 0; }
  const plan = resolveEnv(loadMap(), a.env);
  if (a.diff) {
    const described = parseDescribeYaml(readFileSync(a.diff, "utf8"));
    if (!described.size) { log(`no container env found in ${a.diff} — is it \`gcloud run services describe … --format=yaml\`?`); return 2; }
    const d = diffEnv(plan, described);
    for (const l of diffLines(plan, d)) log(l);
    return diffIsClean(d) ? 0 : 1;
  }
  for (const l of planLines(plan)) log(l);
  return 0;
}

const invoked = process.argv[1] && /live-env-commands\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invoked) {
  try { process.exit(main()); } catch (e) { console.error(`live-env-commands: ${e.message}`); process.exit(2); }
}
