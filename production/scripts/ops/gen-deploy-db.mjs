/**
 * gen-deploy-db — writes the MIGS array of the day's deploy-db scripts from the migration files (R-385, 7 Oct 2026).
 *
 * 7 Oct: every new migration meant the manager hand-edited the MIGS array in BOTH
 * supabase/cloudsql/staging/deploy-db-<date>.sh and supabase/cloudsql/live/deploy-db-<date>.sh —
 * six times in one day. Now each migration file says how to tell it is already applied, in its
 * leading comment block:
 *
 *   -- deploy-peek: exists(select 1 from pg_trigger where tgname='trg_x')   (REQUIRED — SQL boolean, true once applied)
 *   -- deploy-key: oneterm                                                  (optional — short key; default from the file name)
 *   -- deploy-user: postgres                                                (optional — default resellersos_migration)
 *
 * and this script rewrites ONLY the lines between `MIGS=(` and its closing `)` in both scripts.
 * Everything else (backup, peek, the staging-only auth.uid() rewrite in apply()) stays byte-identical.
 *
 *   node scripts/ops/gen-deploy-db.mjs --date 2026-10-07                 # files already listed + every newer migration
 *   node scripts/ops/gen-deploy-db.mjs --date 2026-10-07 --since 20261006130000
 *   node scripts/ops/gen-deploy-db.mjs --date 2026-10-07 --from-script supabase/cloudsql/staging/deploy-db-2026-10-07.sh
 *   node scripts/ops/gen-deploy-db.mjs --date 2026-10-07 --check          # write nothing; exit 1 if a script would change
 *
 * Fails loudly (exit 1, nothing written) when a chosen migration has no `-- deploy-peek:` line, when a
 * peek/key would break the bash line (`|`, `"`, `$`, backtick), when two files share a key, or when a
 * deploy script is missing or has no MIGS block. A brand-new day's scripts: copy yesterday's two
 * scripts to the new date first, then run this with --since.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_USER = "resellersos_migration";
export const ENVS = ["staging", "live"];

/** "20261007160000_quote_one_billing_term.sql" → "20261007160000". */
export function versionOf(file) {
  const m = /^(\d{14})_.+\.sql$/.exec(file);
  return m ? m[1] : null;
}

/** Default key when a file has no `-- deploy-key:` — the name part, letters/digits only, max 12. */
export function defaultKey(file) {
  return file.replace(/^\d{14}_/, "").replace(/\.sql$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12);
}

const BAD_CHARS = /[|"$`]/;

/**
 * Reads the deploy headers from a migration's text. Only the leading comment block counts
 * (lines starting with `--` before the first SQL line), so SQL further down can never be
 * mistaken for a header. Throws with the file name when deploy-peek is missing or unsafe.
 */
export function parseDeployHeaders(sql, file) {
  const out = { file, key: null, user: DEFAULT_USER, peek: null };
  for (const raw of String(sql).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    if (!line.startsWith("--")) break;
    const m = /^--\s*deploy-(peek|key|user):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === "peek") out.peek = v;
    else if (m[1] === "key") out.key = v;
    else out.user = v;
  }
  if (!out.peek) throw new Error(`${file}: no "-- deploy-peek: <SQL boolean>" line in its top comment block — add one (true once the file is applied).`);
  out.key = out.key || defaultKey(file);
  if (!/^[a-z0-9]+$/i.test(out.key)) throw new Error(`${file}: deploy-key "${out.key}" must be letters/digits only.`);
  if (!/^[a-z_][a-z0-9_]*$/i.test(out.user)) throw new Error(`${file}: deploy-user "${out.user}" is not a db user name.`);
  if (BAD_CHARS.test(out.peek)) throw new Error(`${file}: deploy-peek may not contain | " $ or a backtick (it sits inside a bash "…|…" line).`);
  return out;
}

/** One MIGS line, exactly as the scripts have always had it. */
export function migsLine(e) {
  return `  "${e.key}|${e.file}|${e.user}|${e.peek}"`;
}

export function buildMigsBody(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.key)) throw new Error(`deploy-key "${e.key}" is used by both ${seen.get(e.key)} and ${e.file} — give one a "-- deploy-key:" line.`);
    seen.set(e.key, e.file);
  }
  return entries.map(migsLine);
}

/** Splits a deploy script at its MIGS block: { before, body (lines), after }. Keeps the file's own line ending. */
export function splitScript(text, label = "script") {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l === "MIGS=(");
  if (start < 0) throw new Error(`${label}: no "MIGS=(" line.`);
  const end = lines.findIndex((l, i) => i > start && l === ")");
  if (end < 0) throw new Error(`${label}: MIGS=( has no closing ")" line.`);
  return { eol, before: lines.slice(0, start + 1), body: lines.slice(start + 1, end), after: lines.slice(end) };
}

/** Migration file names currently listed in a script's MIGS block. */
export function filesInScript(text, label) {
  return splitScript(text, label).body
    .map((l) => /^\s*"[^|]*\|([^|]+)\|/.exec(l)?.[1])
    .filter(Boolean);
}

export function replaceMigs(text, bodyLines, label) {
  const s = splitScript(text, label);
  return [...s.before, ...bodyLines, ...s.after].join(s.eol);
}

/**
 * Which migration files go in: explicit `since` → every file with version >= since; else the
 * files the script lists now plus every migration newer than the newest listed one (so a new
 * migration lands with no flags at all).
 */
export function selectFiles(allFiles, { since, listed }) {
  const sorted = allFiles.filter((f) => versionOf(f)).sort();
  if (since) return sorted.filter((f) => versionOf(f) >= since);
  if (!listed?.length) throw new Error("No migrations listed in the script yet — pass --since <version>.");
  const missing = listed.filter((f) => !sorted.includes(f));
  if (missing.length) throw new Error(`Script lists files that do not exist: ${missing.join(", ")}`);
  const newest = listed.map(versionOf).sort().pop();
  return [...new Set([...listed, ...sorted.filter((f) => versionOf(f) > newest)])].sort();
}

export function scriptPath(supabaseDir, env, date) {
  return path.join(supabaseDir, "cloudsql", env, `deploy-db-${date}.sh`);
}

/**
 * Pure-ish core: reads migrations + both scripts, returns { env: { file, before, after } }.
 * Writes nothing — main() does that, so tests can prove "regenerating is a no-op".
 */
export function generate({ supabaseDir, date, since, fromScript }) {
  const migDir = path.join(supabaseDir, "migrations");
  /* The staging branch (R-161) moves applied migrations to prisma/migrations/<name>/migration.sql.
     Find a listed file in either place, or the staging build's gate fails on "files that do not exist". */
  const prismaDir = path.join(supabaseDir, "..", "prisma", "migrations");
  const where = new Map(fs.readdirSync(migDir).map((f) => [f, path.join(migDir, f)]));
  if (fs.existsSync(prismaDir)) {
    for (const d of fs.readdirSync(prismaDir)) {
      const sql = path.join(prismaDir, d, "migration.sql");
      if (!where.has(`${d}.sql`) && fs.existsSync(sql)) where.set(`${d}.sql`, sql);
    }
  }
  const scripts = Object.fromEntries(ENVS.map((env) => {
    const file = scriptPath(supabaseDir, env, date);
    if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(supabaseDir, file)} — copy the previous day's ${env} script to this date first.`);
    return [env, { file, before: fs.readFileSync(file, "utf8") }];
  }));
  const listedFrom = fromScript ? fs.readFileSync(fromScript, "utf8") : scripts.staging.before;
  const files = selectFiles([...where.keys()], { since, listed: since ? null : filesInScript(listedFrom, fromScript ?? "staging script") });
  const errors = [];
  const entries = [];
  for (const f of files) {
    try { entries.push(parseDeployHeaders(fs.readFileSync(where.get(f), "utf8"), f)); }
    catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const body = buildMigsBody(entries);
  for (const env of ENVS) scripts[env].after = replaceMigs(scripts[env].before, body, `${env} script`);
  return { files, scripts };
}

function istDate(d = new Date()) {
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const o = { date: istDate(), since: null, fromScript: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") o.date = argv[++i];
    else if (a === "--since") o.since = argv[++i];
    else if (a === "--from-script") o.fromScript = path.resolve(argv[++i]);
    else if (a === "--check") o.check = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? "")) throw new Error("--date must be YYYY-MM-DD");
  if (o.since && !/^\d{14}$/.test(o.since)) throw new Error("--since must be a 14-digit migration version");
  return o;
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const supabaseDir = path.resolve(here, "..", "..", "supabase");
  let res, opts;
  try {
    opts = parseArgs(argv);
    res = generate({ supabaseDir, ...opts });
  } catch (e) {
    console.error(`✗ gen-deploy-db: ${e.message}\nNothing written.`);
    process.exit(1);
  }
  console.log(`${res.files.length} migrations: ${res.files.map(versionOf).join(", ")}`);
  let changed = 0;
  for (const env of ENVS) {
    const s = res.scripts[env];
    const rel = path.relative(process.cwd(), s.file);
    if (s.after === s.before) { console.log(`= ${rel} — no change`); continue; }
    changed++;
    if (opts.check) console.log(`✗ ${rel} — MIGS out of date`);
    else { fs.writeFileSync(s.file, s.after); console.log(`✓ ${rel} — MIGS rewritten`); }
  }
  if (opts.check && changed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
