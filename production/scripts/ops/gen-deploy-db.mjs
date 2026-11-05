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
 *   -- deploy-skip: R-531 redesign first                                    (optional — keep the file OUT of both scripts)
 *
 * and this script rewrites ONLY the lines between `MIGS=(` and its closing `)` in both scripts — and,
 * since R-2480, between `SUPS=(` and its `)` (which migrations a later one supersedes; see below).
 * Everything else (backup, peek, plan(), the staging-only auth.uid() rewrite in apply()) stays
 * byte-identical; tests/r2480-deploy-superseded.test.ts proves plan() is the same in both scripts.
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
 *
 * R-1721 (21 Oct 2026): it ALSO writes src/server/migrations-health/peeks.generated.ts — the same
 * {key, peek} list, fixed at build time, so the deployed app can answer "is every migration I was
 * built with on my DB?" (GET /api/health/migrations). 21 Oct the staging DB step stopped after the
 * backup, the train went on with --db-done, and new code ran ~1 hour without 4 migrations.
 * tests/gen-deploy-db.test.ts fails when that file drifts from the staging script.
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
  const out = { file, key: null, user: DEFAULT_USER, peek: null, skip: null };
  for (const raw of String(sql).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    if (!line.startsWith("--")) break;
    const m = /^--\s*deploy-(peek|key|user|skip):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === "skip") out.skip = v || "skipped";
    else if (m[1] === "peek") out.peek = v;
    else if (m[1] === "key") out.key = v;
    else out.user = v;
  }
  if (!out.peek) throw new Error(`${file}: no "-- deploy-peek: <SQL boolean>" line in its top comment block — add one (true once the file is applied).`);
  out.key = out.key || defaultKey(file);
  if (!/^[a-z0-9]+$/i.test(out.key)) throw new Error(`${file}: deploy-key "${out.key}" must be letters/digits only.`);
  if (!/^[a-z_][a-z0-9_]*$/i.test(out.user)) throw new Error(`${file}: deploy-user "${out.user}" is not a db user name.`);
  if (BAD_CHARS.test(out.peek)) throw new Error(`${file}: deploy-peek may not contain | " $ or a backtick (it sits inside a bash "…|…" line).`);
  /* 9 Oct 2026: a peek that casts with ::regprocedure / ::regclass errors when the object is not
     there yet, and one error blanks the WHOLE peek line — the staging run stopped at step 2. */
  if (/::\s*reg(procedure|proc|class|type)\b/i.test(out.peek)) throw new Error(`${file}: deploy-peek must not cast with ::regprocedure/::regclass — use to_regprocedure(...)/to_regclass(...) so a missing object reads as false, not an error.`);
  return out;
}

/* ── R-2473 (4 Nov 2026): a peek on a function that a LATER migration redefines ─────────────────
   4 Nov staging train: the DB step and the smoke said "DB step chhoot gaya: r2383soleownerapproval"
   although all 23 migrations were applied. R-2383's peek greps tg_quote_approval_not_by_maker()'s
   prosrc for '%R-2383%'; R-2426, R-2441 and R-2447 redefined that function and the newest body no
   longer has the text. A false peek is also dangerous: the next DB step would RE-APPLY R-2383 and put
   its old function body back over R-2447. So when a later (not skipped) migration in the list
   redefines the function, an older peek's `prosrc like/ilike '<x>'` test on it is written as
   `(prosrc like '<x>' or <the newest redefiner's own prosrc test on that function>)`. Checks on
   columns, tables, triggers etc. are left exactly as written. The migration files are never edited
   (CI's migration-order-check refuses that) — only the generated MIGS lines and peeks.generated.ts. */

/**
 * THE parser (R-2480: one copy — localhost-update.mjs imports it): functions and views a migration
 * (re)defines — objects a later `create or replace` overwrites. ["function f", "view v"], lower case,
 * no schema. SQL comments (-- and block) are ignored.
 */
export function redefinedObjects(sql) {
  const src = String(sql ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
  const id = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`;
  const out = new Set();
  for (const m of src.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${id}`, "gi"))) out.add(`function ${m[1].toLowerCase()}`);
  for (const m of src.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"))) out.add(`view ${m[1].toLowerCase()}`);
  return [...out];
}

/** Functions a migration creates or replaces — the function part of redefinedObjects, as a Set of names. */
export function functionsDefined(sql) {
  return new Set(redefinedObjects(sql).filter((o) => o.startsWith("function ")).map((o) => o.slice("function ".length)));
}

/** Index of the ")" closing the "(" at `open`, skipping quoted text ('' inside a literal toggles twice); -1 if unbalanced. */
function closeParen(s, open) {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The `exists(select … from pg_proc where … prosrc like '…')` blocks of a peek that name one function
 * (by `to_regprocedure('public.f(…)')` or `proname = 'f'`):
 * [{ fn, sig (normalised argument list, or null for proname), tests: [{ text, index, alias, test }] }].
 * alias = the table alias before prosrc (`p.` or ""), test = the rest (`like '%R-1%'`).
 * Never touched (review, 4 Nov): `not exists(…)` (a check that a body is GONE — an added "or" would flip
 * it), `prosrc not ilike`, and a test inside a nested pg_proc block counts for the innermost block only.
 */
export function pgProcPeekChecks(peek) {
  const s = String(peek);
  const blocks = [];
  for (const m of s.matchAll(/(\bnot\s+)?\bexists\s*\(/gi)) {
    const end = closeParen(s, m.index + m[0].length - 1);
    if (end < 0) continue;
    const block = s.slice(m.index, end + 1);
    if (!/\bfrom\s+pg_proc\b/i.test(block)) continue;
    const reg = /to_regprocedure\(\s*'(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([^)']*)\)'/i.exec(block);
    const fn = (reg ?? /\bproname\s*=\s*'([a-z_][a-z0-9_]*)'/i.exec(block))?.[1]?.toLowerCase();
    blocks.push({ start: m.index, end: end + 1, negated: Boolean(m[1]), fn, sig: reg ? reg[2].replace(/\s+/g, "").toLowerCase() : null });
  }
  const out = [];
  for (const b of blocks) {
    if (b.negated || !b.fn) continue;
    /* Inside a negated block nothing is a marker; a nested pg_proc block owns its own tests. */
    if (blocks.some((o) => o !== b && o.negated && o.start <= b.start && o.end >= b.end)) continue;
    const inner = blocks.filter((o) => o !== b && o.start > b.start && o.end <= b.end);
    const tests = [...s.slice(b.start, b.end).matchAll(/((?:[a-z_][a-z0-9_]*\.)?)prosrc\s+(i?like\s+'(?:[^']|'')*')/gi)]
      .map((t) => ({ text: t[0], index: b.start + t.index, alias: t[1], test: t[2] }))
      .filter((t) => !inner.some((o) => t.index >= o.start && t.index < o.end));
    if (tests.length) out.push({ fn: b.fn, sig: b.sig, tests });
  }
  return out;
}

/**
 * entries: parsed headers in apply order, each with `sql` (the migration text) and `skip`.
 * Returns new entries whose peeks accept the newest redefiner's marker (see above). The marker must be on
 * the same function and, when both name one, the same argument list (an overload is another function).
 * When the newest redefiner's peek has no such prosrc test (26 such pairs on 4 Nov — old headers may not
 * be edited), the alternative is that migration's whole peek: "the newest migration is in", which is
 * exactly what the deploy step uses to skip that migration — and then the older body is gone by design
 * (localhost-update skips such a file as superseded for the same reason).
 */
export function supersedePeeks(entries) {
  const defines = entries.map((e) => (e.skip ? new Set() : functionsDefined(e.sql)));
  const checks = entries.map((e) => (e.skip ? [] : pgProcPeekChecks(e.peek)));
  const newestFor = new Map(); // fn → newest index defining it, filled as we walk back
  const out = [...entries];
  /* Newest first, so a redefiner's own (already widened) peek is what an older one embeds. */
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.skip) continue;
    const edits = [];
    for (const c of checks[i]) {
      const j = newestFor.get(c.fn);
      if (j === undefined) continue;
      const own = checks[j].find((n) => n.fn === c.fn && (!n.sig || !c.sig || n.sig === c.sig))?.tests[0];
      for (const t of c.tests) {
        /* The marker is re-qualified with THIS block's alias (`p.prosrc` here, bare `prosrc` there). */
        if (own && own.test.toLowerCase() === t.test.toLowerCase()) continue;
        edits.push({ ...t, mark: own ? `${t.alias}prosrc ${own.test}` : `(${out[j].peek})` });
      }
    }
    for (const fn of defines[i]) if (!newestFor.has(fn)) newestFor.set(fn, i);
    if (!edits.length) continue;
    let peek = e.peek;
    for (const d of edits.sort((a, b) => b.index - a.index)) {
      peek = `${peek.slice(0, d.index)}(${d.text} or ${d.mark})${peek.slice(d.index + d.text.length)}`;
    }
    out[i] = { ...e, peek };
  }
  return out;
}

/* ── R-2480 (5 Nov 2026): never RE-RUN a superseded migration ────────────────────────────────────
   R-2473's widened peek accepts only a migration's own marker or the NEWEST redefiner's. Staging sat on
   the R-2447 body of tg_quote_approval_not_by_maker while R-2470 (the newest redefiner) was not in yet,
   so R-2383's (and R-2426's, R-2441's) peek read false and the DB step would have re-run them — their
   older, weaker approval rule back on staging, with R-2447 not re-run after them (its peek is true).
   The deploy scripts now get a SUPS block next to MIGS, one line per migration whose function/view a
   LATER listed migration redefines:  "key|<later keys, space separated>|<rest peek or empty>".
   rest = the migration's own peek with its prosrc tests on those redefined functions read as `true`:
   "are its OTHER parts (columns, tables, triggers, other functions) in?". Empty = same as the peek.
   The script (plan(), after the read-only PEEK) then decides per migration whose peek is false:
     - a later redefiner is in (or itself superseded) and rest is true → SUPERSEDED: not re-run, reported;
     - a later redefiner is in but rest is not true → STOP before any change (re-running brings the old
       body back, skipping loses a column/table — a new migration is the fix; the safe rule);
     - no later redefiner is in (a fresh DB) → applied in file order, exactly as before.
   The peek is the file's truth: a part its peek never checks cannot be seen here either. */

/** The peek with its prosrc text tests on `fns` (function names) read as `true`. Negated blocks stay as written. */
export function residualPeek(peek, fns) {
  const tests = pgProcPeekChecks(peek).filter((c) => fns.has(c.fn)).flatMap((c) => c.tests);
  let out = String(peek);
  for (const t of tests.sort((a, b) => b.index - a.index)) out = `${out.slice(0, t.index)}true${out.slice(t.index + t.text.length)}`;
  return out;
}

/**
 * entries: parsed headers in apply order, each with `sql`, `peek` (its OWN header peek) and `skip`.
 * → [{ key, later: [keys of later, not skipped migrations redefining one of its functions/views], rest: sql | null }].
 */
export function supersededEntries(entries) {
  const live = entries.filter((e) => !e.skip);
  const objs = live.map((e) => new Set(redefinedObjects(e.sql)));
  const out = [];
  live.forEach((e, i) => {
    const later = [];
    const shared = new Set();
    for (let j = i + 1; j < live.length; j++) {
      const both = [...objs[i]].filter((o) => objs[j].has(o));
      if (!both.length) continue;
      later.push(live[j].key);
      for (const o of both) shared.add(o);
    }
    if (!later.length) return;
    const fns = new Set([...shared].filter((o) => o.startsWith("function ")).map((o) => o.slice("function ".length)));
    const rest = residualPeek(e.peek, fns);
    out.push({ key: e.key, later, rest: rest === e.peek ? null : rest });
  });
  return out;
}

export function supsLine(s) {
  return `  "${s.key}|${s.later.join(" ")}|${s.rest ?? ""}"`;
}

/** Does the script have a `SUPS=(` block (deploy scripts since R-2480; a bare test fixture may not)? */
export function hasSups(text) {
  return /(^|\r?\n)SUPS=\(\r?\n/.test(String(text));
}

/** SUPS lines → [{ key, later, rest }] ([] for a script without the block). */
export function supsFromScript(text, label = "script") {
  if (!hasSups(text)) return [];
  return splitBlock(text, "SUPS", label).body
    .map((l) => /^\s*"([^|]+)\|([^|]*)\|([^|]*)"\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ key: m[1], later: m[2].split(" ").filter(Boolean), rest: m[3] || null }));
}

/**
 * What /api/health/migrations checks: a migration with a separate rest check is green when its own
 * marker OR its rest is in — a superseded file's other parts are there, and its function's newer body is
 * checked by the later migration's own entry in the same list.
 */
export function healthPeeks(peeks, sups) {
  const rest = new Map(sups.filter((s) => s.rest).map((s) => [s.key, s.rest]));
  return peeks.map((p) => (rest.has(p.key) ? { key: p.key, peek: `(${p.peek}) or (${rest.get(p.key)})` } : p));
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

/** Splits a deploy script at its `<name>=(` block: { before, body (lines), after }. Keeps the file's own line ending. */
export function splitBlock(text, name, label = "script") {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l === `${name}=(`);
  if (start < 0) throw new Error(`${label}: no "${name}=(" line.`);
  const end = lines.findIndex((l, i) => i > start && l === ")");
  if (end < 0) throw new Error(`${label}: ${name}=( has no closing ")" line.`);
  return { eol, before: lines.slice(0, start + 1), body: lines.slice(start + 1, end), after: lines.slice(end) };
}

/** Splits a deploy script at its MIGS block. */
export function splitScript(text, label = "script") {
  return splitBlock(text, "MIGS", label);
}

/** Migration file names currently listed in a script's MIGS block. */
export function filesInScript(text, label) {
  return splitScript(text, label).body
    .map((l) => /^\s*"[^|]*\|([^|]+)\|/.exec(l)?.[1])
    .filter(Boolean);
}

export function replaceMigs(text, bodyLines, label) {
  return replaceBlock(text, "MIGS", bodyLines, label);
}

export function replaceBlock(text, name, bodyLines, label) {
  const s = splitBlock(text, name, label);
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

/** MIGS lines → [{ key, peek }] in file order (a peek never holds `|` — parseDeployHeaders refuses it). */
export function peeksFromScript(text, label = "script") {
  return splitScript(text, label).body
    .map((l) => /^\s*"([^|]+)\|[^|]+\|[^|]+\|(.+)"\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ key: m[1], peek: m[2] }));
}

/** Relative to production/. */
export const PEEKS_FILE = "src/server/migrations-health/peeks.generated.ts";

/** The TypeScript the app is built with. Plain data — the route never takes SQL from a request. */
export function renderPeeksModule(peeks, source) {
  return [
    "/* GENERATED by scripts/ops/gen-deploy-db.mjs (R-1721) — do not edit by hand.",
    `   Source: ${source} (MIGS block). Rerun: node scripts/ops/gen-deploy-db.mjs --date <date> */`,
    "export const MIGRATION_PEEKS: ReadonlyArray<{ readonly key: string; readonly peek: string }> = [",
    ...peeks.map((p) => `  { key: ${JSON.stringify(p.key)}, peek: ${JSON.stringify(p.peek)} },`),
    "];",
    "",
  ].join("\n");
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
    try {
      const sql = fs.readFileSync(where.get(f), "utf8");
      entries.push({ ...parseDeployHeaders(sql, f), sql });
    } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  /* R-2473: an older prosrc marker on a function a later migration redefines also accepts the newest one's. */
  const peeked = supersedePeeks(entries).map(({ sql: _sql, ...e }) => e);
  /* R-531 (10 Oct 2026): a file can stay in the repo but out of every deploy — `-- deploy-skip: <why>`. */
  const skipped = peeked.filter((e) => e.skip);
  const body = buildMigsBody(peeked.filter((e) => !e.skip));
  /* R-2480: which migrations a later one supersedes, and their "other parts" check (from the OWN peeks). */
  const sups = supersededEntries(entries).map(supsLine);
  for (const env of ENVS) {
    const migs = replaceMigs(scripts[env].before, body, `${env} script`);
    /* A script without the SUPS block has no plan() either (only bare test fixtures) — MIGS only, as before. */
    scripts[env].after = hasSups(migs) ? replaceBlock(migs, "SUPS", sups, `${env} script`) : migs;
  }
  return { files: files.filter((f) => !skipped.some((e) => e.file === f)), skipped, scripts };
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
  for (const e of res.skipped) console.log(`- skipped ${e.file}: ${e.skip}`);
  let changed = 0;
  const appDir = path.resolve(supabaseDir, "..");
  const peeksAbs = path.join(appDir, ...PEEKS_FILE.split("/"));
  const source = path.relative(appDir, res.scripts.staging.file).split(path.sep).join("/");
  const stagingAfter = res.scripts.staging.after;
  const peeksAfter = renderPeeksModule(healthPeeks(peeksFromScript(stagingAfter, "staging script"), supsFromScript(stagingAfter, "staging script")), source);
  const peeksBefore = fs.existsSync(peeksAbs) ? fs.readFileSync(peeksAbs, "utf8").replace(/\r\n/g, "\n") : null;
  if (peeksBefore === peeksAfter) console.log(`= ${PEEKS_FILE} — no change`);
  else if (opts.check) { changed++; console.log(`✗ ${PEEKS_FILE} — out of date`); }
  else { fs.writeFileSync(peeksAbs, peeksAfter); console.log(`✓ ${PEEKS_FILE} — rewritten`); }
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
