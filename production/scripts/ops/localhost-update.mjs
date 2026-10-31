#!/usr/bin/env node
/**
 * `npm run localhost:update` — move the localhost checkout to the newest anutech/manager-pardeep and
 * bring the LOCAL database up to it (R-2106, 31 Oct 2026).
 *
 * Why: every worker/checker repeated the same manual steps on C:/Users/mso50/reselleros-deploy (stash
 * the local dev-local.mjs edit by tag, detach to anutech/manager-pardeep, re-apply, drop) and applied
 * migrations by hand — the R-2101 migration was missed on localhost until the coordinator read its
 * deploy-peek. One command now does all of it and prints what it did.
 *
 *   npm run localhost:update                        (from reselleros-deploy/production)
 *   npm run localhost:update -- --dry-run           prints the plan; changes nothing (peeks are read-only selects)
 *   node scripts/ops/localhost-update.mjs --dir C:/Users/mso50/reselleros-deploy [--to <ref>] [--dry-run]
 *
 * Steps:
 *   1. git fetch anutech; target = anutech/manager-pardeep (or --to).
 *   2. Local edits: only production/scripts/dev-local.mjs may be modified (KEEP_LOCAL). Any other tracked
 *      change → stop, nothing touched. Untracked files are left alone.
 *   3. The kept edit: a backup patch in the OS temp folder, `git stash push -m <unique tag> -- <file>`,
 *      its SHA read from `git stash list` BY TAG (the stash stack is shared by every worktree of the clone,
 *      other sessions push/pop it too), `git checkout --detach <target>`, `git stash apply <sha>`, then
 *      drop — re-finding its current stash@{n} by tag first. A conflict on apply keeps the stash entry and
 *      stops (exit 2) with the sha to apply by hand.
 *   4. Migrations: every supabase/migrations file with a `-- deploy-peek:` header (no deploy-skip) has its
 *      peek read on the LOCAL DB (docker supabase_db_*). Peek false → applied in version order (psql
 *      ON_ERROR_STOP), then its peek must read true; the first failure stops (exit 3).
 *      SUPERSEDED (R-2125 check, 30 Oct): a peek-false migration whose function/view is redefined by a
 *      LATER migration that is applied (or unknown, or itself skipped) is NOT applied — running it would
 *      bring back the old function body. Printed as "superseded by <later> (<object>)". On 31 Oct this is
 *      exactly 20261018173040 (current_user_has_role, redefined by applied 20261025141647) and
 *      20261010223000 (list_tenant_backups, redefined by the skipped 20261018173040).
 *   5. Prints: from → to, the cards in between, the kept edit, migrations applied / skipped / unknown,
 *      files that may need a restart or `npm ci` (never done here), where dev:local's CRON_SECRET comes from.
 *
 * It NEVER restarts or starts the dev server (Next reloads code by itself; a restart is the coordinator's
 * call), never touches staging/live, never pushes. It refuses a checkout that sits on a branch (only a
 * detached localhost checkout like reselleros-deploy is moved).
 *
 * Exit: 0 ok · 1 refused / git error · 2 stash apply conflict (stash kept) · 3 a migration failed ·
 *       4 local DB not reachable (code moved, migrations not checked).
 * Tests: tests/ops/localhost-update.test.ts (fake git/psql + a real throwaway git repo; never the real
 * reselleros-deploy, never the real remote).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDeployHeaders } from "./gen-deploy-db.mjs";
import { LOCAL_CRON_SECRET } from "../cron-local.mjs";

export const REMOTE = "anutech";
export const TARGET = `${REMOTE}/manager-pardeep`;
export const MIGRATIONS_DIR = "production/supabase/migrations";
/** The only tracked local edits kept across the move (repo-root relative). */
export const KEEP_LOCAL = ["production/scripts/dev-local.mjs"];
export const EXIT = { ok: 0, refused: 1, stashConflict: 2, migrationFailed: 3, noDb: 4 };

/* ───────────── pure helpers ───────────── */

/** `git status --porcelain` → [{ code, file }] (rename "a -> b" keeps b). */
export function parsePorcelain(text) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.length > 3).map((l) => {
    const code = l.slice(0, 2);
    let file = l.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ").pop();
    return { code, file: file.replace(/^"|"$/g, "").replace(/\\/g, "/") };
  });
}

/** Which local changes are kept (stashed + re-applied) and which block the move. Untracked never blocks. */
export function planLocalEdits(entries, keep = KEEP_LOCAL) {
  const kept = [], blockers = [];
  for (const e of entries) {
    if (e.code === "??") continue;
    if (keep.includes(e.file)) kept.push(e.file);
    else blockers.push(`${e.code.trim() || "?"} ${e.file}`);
  }
  return { kept, blockers };
}

/** `git stash list --format=%H %gs` → the sha of the entry whose subject ends with the tag. */
export function stashShaFor(listText, tag) {
  for (const l of String(listText ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{7,40}) (.*)$/.exec(l.trim());
    if (m && m[2].endsWith(tag)) return m[1];
  }
  return null;
}

/** `git stash list --format=%gd %gs` → the CURRENT stash@{n} of the tagged entry (others may have pushed since). */
export function stashRefFor(listText, tag) {
  for (const l of String(listText ?? "").split(/\r?\n/)) {
    const m = /^(stash@\{\d+\}) (.*)$/.exec(l.trim());
    if (m && m[2].endsWith(tag)) return m[1];
  }
  return null;
}

/** Functions and views a migration (re)defines — objects a later `create or replace` overwrites. Lower case, no schema. */
export function redefinedObjects(sql) {
  const src = String(sql ?? "").replace(/--[^\n]*/g, "");
  const id = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`;
  const out = new Set();
  for (const m of src.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${id}`, "gi"))) out.add(`function ${m[1].toLowerCase()}`);
  for (const m of src.matchAll(new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"))) out.add(`view ${m[1].toLowerCase()}`);
  return [...out];
}

/** One read-only select per migration: `file|true|false|null`. A peek that errors prints no line (→ unknown). */
export function peekScript(migs) {
  return migs.map((m) => `select ${sqlString(m.file + "|")} || coalesce((${m.peek})::text, 'null');`).join("\n") + "\n";
}
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** psql -tA output → Map file → "true" | "false" | "null". */
export function parsePeekOutput(text) {
  const map = new Map();
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\d{14}_[^|]+\.sql)\|(true|false|null)$/.exec(l.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * migs: [{ file, defines: [...], status: "applied" | "pending" | "unknown" }] (any order).
 * → { apply: [file] (ascending), skip: [{ file, reason }], unknown: [file], applied: n }.
 * A pending migration is skipped when an object it defines is defined again by a LATER migration
 * that will not run after it in this pass (applied, unknown, or itself skipped).
 */
export function planMigrations(migs) {
  const sorted = [...migs].sort((a, b) => a.file.localeCompare(b.file));
  const skipped = new Map();
  const apply = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m.status !== "pending") continue;
    let reason = null;
    for (const obj of m.defines ?? []) {
      const later = sorted.slice(i + 1).find((n) => (n.defines ?? []).includes(obj) && (n.status !== "pending" || skipped.has(n.file)));
      if (later) {
        const why = later.status === "applied" ? "applied" : later.status === "unknown" ? "peek unknown" : "itself skipped";
        reason = `superseded by ${later.file} (${obj}; ${why}) — chalane se purani body wapas aa jaati`;
        break;
      }
    }
    if (reason) skipped.set(m.file, reason);
    else apply.unshift(m.file);
  }
  return {
    apply,
    skip: [...skipped].map(([file, reason]) => ({ file, reason })).sort((a, b) => a.file.localeCompare(b.file)),
    unknown: sorted.filter((m) => m.status === "unknown").map((m) => m.file),
    applied: sorted.filter((m) => m.status === "applied").length,
  };
}

/** Changed paths (old..new) that the running dev server / node_modules do NOT pick up by themselves. */
export function restartHints(changed) {
  const lines = [];
  const has = (re) => changed.filter((f) => re.test(f));
  const lock = has(/^production\/package(-lock)?\.json$/);
  if (lock.length) lines.push(`! ${lock.join(", ")} badla — dependencies badli ho sakti hain: \`npm ci\` (production/) chahiye ho sakta hai. Is script ne NAHI chalaya.`);
  const cfg = has(/^production\/(next\.config\.[cm]?[jt]s|\.env[^/]*|instrumentation\.ts|src\/instrumentation\.ts|scripts\/dev-local\.mjs)$/);
  if (cfg.length) lines.push(`! ${cfg.join(", ")} badla — ye dev server restart par hi lagta hai. Restart coordinator ka faisla; is script ne server ko haath NAHI lagaya.`);
  const prisma = has(/^production\/prisma\/schema\.prisma$/);
  if (prisma.length) lines.push("! prisma/schema.prisma badla — `npx prisma generate` (production/) chahiye. Is script ne NAHI chalaya.");
  return lines;
}

/** Where dev:local's CRON_SECRET comes from, and how to call a cron on localhost (alsoDo2, 29 Oct demo: every cron 401). */
export function cronSecretLines(port = 3001) {
  return [
    `CRON_SECRET (dev:local) = "${LOCAL_CRON_SECRET}" — scripts/dev-local.mjs khud set karta hai, .env.local wala NAHI (isiliye .env.local ke secret se har cron 401).`,
    `  Cron chalao: npm run cron:local <job> -- --dry   (jaise: npm run cron:local renewals -- --dry; port ${port}, --port badlo)`,
  ];
}

/** Keys that send mail/messages/money. dev:local must blank them (allowlist ALLOW in dev-local.mjs). */
export const SEND_KEY_RE = /RESEND|SMTP|GUPSHUP|RAZORPAY|VAPI|WHATSAPP_(TOKEN|API|ACCESS)|TWILIO|MSG91|SENDGRID|MAILGUN|POSTMARK|EXOTEL|META_|GMAIL_|SES_/i;

/** The ALLOW keys in a dev-local.mjs source. */
export function devLocalAllowKeys(src) {
  const m = /const ALLOW = new Set\(\[([\s\S]*?)\]\);/.exec(String(src ?? ""));
  if (!m) return null;
  return [...m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((x) => x[1]);
}

/** ALLOW keys that would let a real send through on localhost ([] = safe; null = ALLOW block not found). */
export function sendKeysAllowed(src) {
  const keys = devLocalAllowKeys(src);
  return keys ? keys.filter((k) => SEND_KEY_RE.test(k)) : null;
}

const CARD_RE = /\bR-\d{2,4}[a-z]?\b/g;
export function cardsIn(subjects) {
  const set = new Set();
  for (const s of subjects) for (const m of String(s).matchAll(CARD_RE)) set.add(m[0]);
  return [...set].sort((a, b) => Number(a.slice(2).replace(/\D/g, "")) - Number(b.slice(2).replace(/\D/g, "")));
}

export function parseArgs(argv) {
  const out = { dryRun: false, dir: null, to: TARGET, noFetch: false, port: 3001, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--no-fetch") out.noFetch = true;
    else if (a === "--port") out.port = Number(argv[++i]) || 3001;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument ${a} (--dry-run / --dir <checkout> / --to <ref> / --no-fetch / --port <n>)`);
  }
  return out;
}

/* ───────────── the run (git + psql injected) ───────────── */

/**
 * git(args) → stdout (throws on a non-zero exit); psql(sql, { stopOnError }) → { status, out } or null when no
 * local DB; writeFile(path, text) for the backup patch. Returns { code, lines }.
 */
export function runUpdate({ git, psql, print = () => {}, dryRun = false, to = TARGET, noFetch = false, port = 3001, tmpDir = os.tmpdir(), writeFile = (p, t) => fs.writeFileSync(p, t), readFile = null, now = () => new Date() }) {
  const lines = [];
  const say = (l) => { lines.push(l); print(l); };
  const done = (code) => ({ code, lines });

  /* 1. where we are, where we go */
  let branch = "";
  try { branch = git(["symbolic-ref", "-q", "--short", "HEAD"]).trim(); } catch { branch = ""; }
  if (branch) {
    say(`✗ Ye checkout branch "${branch}" par hai — localhost:update sirf detached localhost checkout (reselleros-deploy) ko hilata hai. Kuch nahi badla.`);
    return done(EXIT.refused);
  }
  if (!noFetch) git(["fetch", "-q", REMOTE]);
  const before = git(["rev-parse", "HEAD"]).trim();
  let target;
  try { target = git(["rev-parse", "--verify", `${to}^{commit}`]).trim(); }
  catch { say(`✗ ${to} nahi mila (git fetch ${REMOTE}?). Kuch nahi badla.`); return done(EXIT.refused); }
  const moving = before !== target;
  let subjects = [];
  if (moving) {
    try { subjects = git(["log", "--no-merges", "--format=%s", `${before}..${target}`]).split(/\r?\n/).filter(Boolean); } catch {}
  }

  /* 2. local edits */
  const { kept, blockers } = planLocalEdits(parsePorcelain(git(["status", "--porcelain"])));
  if (blockers.length) {
    say(`✗ Is checkout me aur badlav hain (sirf ${KEEP_LOCAL.join(", ")} rakha jaata hai) — kuch nahi badla:`);
    for (const b of blockers) say(`   ${b}`);
    say("   Ye kiske hain pehle pata karo (coordinator/Pardeep). Khud mat hatao.");
    return done(EXIT.refused);
  }
  say(`${dryRun ? "[dry-run] " : ""}Code: ${before.slice(0, 9)} → ${target.slice(0, 9)} (${to})${moving ? `, ${subjects.length} commit` : " — pehle se yahi"}`);
  if (moving && subjects.length) say(`  Cards: ${cardsIn(subjects).join(", ") || "—"}`);
  let changed = [];
  if (moving) { try { changed = git(["diff", "--name-only", before, target]).split(/\r?\n/).filter(Boolean); } catch {} }

  /* 3. move, keeping the local edit */
  if (moving && dryRun) {
    say(kept.length ? `  [dry-run] local edit rakhi jaati: ${kept.join(", ")} (stash by tag → checkout → apply by sha → drop)` : "  [dry-run] koi local edit nahi.");
  } else if (moving) {
    let stashSha = null, tag = null;
    if (kept.length) {
      tag = `localhost-update-${now().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
      const patch = path.join(tmpDir, `${tag}.patch`);
      try { writeFile(patch, git(["diff", "--", ...kept])); say(`  Backup patch: ${patch}`); } catch {}
      git(["stash", "push", "-m", tag, "--", ...kept]);
      stashSha = stashShaFor(git(["stash", "list", "--format=%H %gs"]), tag);
      if (!stashSha) { say(`✗ stash "${tag}" nahi mila — ruk gaye. Backup patch upar hai.`); return done(EXIT.refused); }
      say(`  Local edit stash: ${tag} @ ${stashSha.slice(0, 9)}`);
    }
    try { git(["checkout", "-q", "--detach", target]); }
    catch (e) {
      say(`✗ checkout ${target.slice(0, 9)} fail: ${String(e?.stderr ?? e?.message ?? e).split("\n")[0]}`);
      if (stashSha) {
        try { git(["stash", "apply", stashSha]); dropByTag(git, tag); say("  Local edit wapas lagayi (purane commit par)."); }
        catch { say(`  ! Local edit wapas NAHI lagi — haath se: git stash apply ${stashSha}`); }
      }
      return done(EXIT.refused);
    }
    if (stashSha) {
      try { git(["stash", "apply", stashSha]); }
      catch (e) {
        say(`✗ Local edit naye code par saaf nahi lagi (conflict): ${kept.join(", ")}. Stash RAKHA: ${tag} @ ${stashSha}.`);
        say(`  Haath se sulajhao (git status), phir: git stash drop <us entry ka stash@{n}>. Server ko haath mat lagao.`);
        return done(EXIT.stashConflict);
      }
      const dropped = dropByTag(git, tag);
      say(`  Local edit wapas lagi: ${kept.join(", ")}${dropped ? ` (stash ${dropped} drop)` : ` (! stash ${tag} drop nahi hua — git stash list dekho)`}`);
    }
  }

  /* 4. migrations of the target, read with git (works for --dry-run too) */
  const ref = dryRun ? target : "HEAD";
  const names = git(["ls-tree", "--name-only", `${ref}:${MIGRATIONS_DIR}`]).split(/\r?\n/).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  const migs = [];
  for (const f of names) {
    const sql = readFile ? readFile(ref, `${MIGRATIONS_DIR}/${f}`) : git(["show", `${ref}:${MIGRATIONS_DIR}/${f}`]);
    let h; try { h = parseDeployHeaders(sql, f); } catch { continue; }
    if (h.skip) continue;
    migs.push({ file: f, peek: h.peek, sql, defines: redefinedObjects(sql) });
  }
  const r = psql ? psql(peekScript(migs), { stopOnError: false }) : null;
  if (!r) {
    say("! Local DB (docker supabase_db_*) nahi mila — migrations jaanche/lagaye NAHI. `npx supabase start`, phir dobara.");
    finish(say, { changed, port, kept, git });
    return done(EXIT.noDb);
  }
  const peeks = parsePeekOutput(r.out);
  for (const m of migs) { const v = peeks.get(m.file); m.status = v === "true" ? "applied" : v === "false" ? "pending" : "unknown"; }
  const plan = planMigrations(migs);
  say(`Migrations (deploy-peek wale ${migs.length}): ${plan.applied} lage hue, ${plan.apply.length} lagane, ${plan.skip.length} superseded, ${plan.unknown.length} peek unknown`);
  for (const s of plan.skip) say(`  skip ${s.file} — ${s.reason}`);
  for (const u of plan.unknown) say(`  ? ${u} — peek error/null; NAHI lagaya (haath se jaancho)`);
  let code = EXIT.ok;
  for (const f of plan.apply) {
    const m = migs.find((x) => x.file === f);
    if (dryRun) { say(`  [dry-run] lagata: ${f}`); continue; }
    const a = psql(m.sql, { stopOnError: true });
    if (a.status !== 0) { say(`✗ ${f} FAIL — ruk gaye (baaki nahi lage):\n${String(a.out).trim().split("\n").slice(-6).join("\n")}`); code = EXIT.migrationFailed; break; }
    const after = parsePeekOutput(psql(peekScript([m]), { stopOnError: false })?.out).get(f);
    if (after !== "true") { say(`✗ ${f} chala par uska deploy-peek ab bhi ${after ?? "error"} — ruk gaye. Migration/peek jaancho.`); code = EXIT.migrationFailed; break; }
    say(`  ✓ lagaya: ${f}`);
  }
  if (!plan.apply.length) say("  Koi migration lagani nahi thi.");
  finish(say, { changed, port, kept, git });
  return done(code);
}

function dropByTag(git, tag) {
  const ref = stashRefFor(git(["stash", "list", "--format=%gd %gs"]), tag);
  if (!ref) return null;
  git(["stash", "drop", "-q", ref]);
  return ref;
}

function finish(say, { changed, port, kept, git }) {
  for (const l of restartHints(changed)) say(l);
  if (kept.length) {
    let src = null; /* the working-tree file: the re-applied local edit is what dev:local runs */
    try { src = fs.readFileSync(path.join(git(["rev-parse", "--show-toplevel"]).trim(), KEEP_LOCAL[0]), "utf8"); } catch {}
    const bad = src == null ? null : sendKeysAllowed(src);
    if (bad === null) say("! dev-local.mjs me ALLOW block nahi mila — live keys band hain ya nahi, jaancho.");
    else if (bad.length) say(`! dev-local.mjs ki local edit ALLOW me bhejne wali key rakhti hai: ${bad.join(", ")} — localhost se asli mail/message ja sakta hai. Hatao.`);
  }
  for (const l of cronSecretLines(port)) say(l);
  say("Dev server ko haath NAHI lagaya (restart nahi kiya). Next code khud reload karta hai.");
}

/* ───────────── CLI ───────────── */

function realPsql() {
  let container = null;
  try {
    container = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })
      .split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  } catch { container = null; }
  if (!container) return null;
  return (sql, { stopOnError }) => {
    const r = spawnSync("docker", ["exec", "-i", container, "psql", "-v", `ON_ERROR_STOP=${stopOnError ? 1 : 0}`, "-tA", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`✗ ${e.message}`); process.exit(EXIT.refused); }
  if (args.help) { console.log("npm run localhost:update [-- --dry-run] [--dir <checkout>] [--to <ref>] [--port 3001]"); return; }
  const start = args.dir ? path.resolve(args.dir) : process.cwd();
  let top;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { console.error(`✗ ${start} git checkout nahi hai.`); process.exit(EXIT.refused); }
  console.log(`localhost:update → ${top}${args.dryRun ? "  (dry-run: kuch nahi badlega)" : ""}`);
  const git = (a) => execFileSync("git", a, { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  let r;
  try { r = runUpdate({ git, psql: realPsql(), print: (l) => console.log(l), dryRun: args.dryRun, to: args.to, noFetch: args.noFetch, port: args.port }); }
  catch (e) { console.error(`✗ ${String(e?.stderr ?? e?.message ?? e).slice(0, 800)}`); process.exit(EXIT.refused); }
  process.exit(r.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
