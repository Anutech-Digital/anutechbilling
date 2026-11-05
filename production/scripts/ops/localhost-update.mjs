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
 *   npm run localhost:update -- --repair            also fixes a BLOCKED migration (R-2484, local DB only; see step 4)
 *   node scripts/ops/localhost-update.mjs --dir C:/Users/mso50/reselleros-deploy [--to <ref>] [--dry-run] [--repair]
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
 *      SUPERSEDED (R-2125 check, 30 Oct — REPLACED by R-2484): a peek-false migration whose function/view
 *      a LATER applied migration redefines was skipped. R-2484 (5 Nov): that rule had no "other parts" check — 20261018173040 is the ONLY definer of
 *      get_tenant_backup's R-1557 body, so skipping it left the local DB on the old, unsafe body. Now
 *      it is R-2480's deploy rule (plan() in the deploy-db scripts), on the generator's own data
 *      (deployEntries: supersedePeeks / supersededEntries from gen-deploy-db — no second copy):
 *      superseded = a later redefiner is in AND its rest peek is true → not applied; blocked = a later
 *      redefiner is in but rest is not true → stop before any migration (exit 5) with the next step:
 *      `--repair` (local only) applies it in file order and then re-runs the newest (applied) definer
 *      of every function/view it overwrote (see planMigrations for what it does NOT restore);
 *      `--accept-superseded <keys>` (or env ACCEPT_SUPERSEDED) = the deploy script's checked way on.
 *      5 Nov example: R-2469 (release_stale_team_invite) was skipped because R-2471 redefines
 *      tenant_holds_business_records — the local DB lost release_stale_team_invite. Now: blocked.
 *      tests/ops/localhost-update-superseded.test.ts runs the deploy script's bash plan() against
 *      planMigrations on the same answers.
 *   5. Prints: from → to, the cards in between, the kept edit, migrations applied / skipped / unknown,
 *      files that may need a restart or `npm ci` (never done here), where dev:local's CRON_SECRET comes from.
 *
 * It NEVER restarts or starts the dev server (Next reloads code by itself; a restart is the coordinator's
 * call), never touches staging/live, never pushes. It refuses a checkout that sits on a branch (only a
 * detached localhost checkout like reselleros-deploy is moved).
 *
 * Exit: 0 ok · 1 refused / git error · 2 stash apply conflict (stash kept) · 3 a migration failed ·
 *       4 local DB not reachable (code moved, migrations not checked) ·
 *       5 blocked migration (R-2484; code moved, no migration run) — `-- --dry-run --repair`, then `-- --repair`.
 * Tests: tests/ops/localhost-update.test.ts (fake git/psql + a real throwaway git repo; never the real
 * reselleros-deploy, never the real remote).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDeployHeaders, redefinedObjects, supersedePeeks, supersededEntries } from "./gen-deploy-db.mjs";
import { LOCAL_CRON_SECRET } from "../cron-local.mjs";

export const REMOTE = "anutech";
export const TARGET = `${REMOTE}/manager-pardeep`;
export const MIGRATIONS_DIR = "production/supabase/migrations";
/** The only tracked local edits kept across the move (repo-root relative). */
export const KEEP_LOCAL = ["production/scripts/dev-local.mjs"];
export const EXIT = { ok: 0, refused: 1, stashConflict: 2, migrationFailed: 3, noDb: 4, blocked: 5 };

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

/* Functions and views a migration (re)defines: ONE parser, shared with the deploy-db generator (R-2480). */
export { redefinedObjects };

/**
 * R-2484 (5 Nov 2026): the deploy scripts' data, from the deploy generator itself — no second copy.
 * files: [{ file, sql }] → [{ file, key, peek, sql, defines, later: [keys], rest: sql | null }] in file order.
 *   peek  = the peek the deploy script reads (R-2473 supersedePeeks: an older prosrc marker also accepts
 *           the newest redefiner's);
 *   later = the LATER migrations redefining one of its functions/views (gen-deploy-db's SUPS block);
 *   rest  = its "other parts" check (its own peek with the prosrc tests on those functions read as true);
 *           null = no separate check (the SUPS line's empty third field).
 * A file without a usable deploy header, or with deploy-skip, is left out (as the deploy scripts do).
 */
export function deployEntries(files) {
  const entries = [];
  for (const { file, sql } of files) {
    let h; try { h = parseDeployHeaders(sql, file); } catch { continue; }
    entries.push({ ...h, sql });
  }
  entries.sort((x, y) => byName(x.file, y.file));
  /* Same refusal as the deploy generator: a key names ONE migration (plan() works by key). */
  const seen = new Map();
  for (const e of entries) {
    if (e.skip) continue;
    if (seen.has(e.key)) throw new Error(`deploy-key "${e.key}" is used by ${seen.get(e.key)} and ${e.file} — give one a -- deploy-key: line.`);
    seen.set(e.key, e.file);
  }
  const widened = supersedePeeks(entries);
  const sups = new Map(supersededEntries(entries).map((s) => [s.key, s]));
  return widened.filter((e) => !e.skip).map((e) => ({
    file: e.file, key: e.key, peek: e.peek, sql: e.sql, defines: redefinedObjects(e.sql),
    later: sups.get(e.key)?.later ?? [], rest: sups.get(e.key)?.rest ?? null,
  }));
}

/**
 * One read-only select per migration: `file|true|false|null`, and for a migration with a rest check also
 * `file#rest|…` (the deploy script's `key_rest=`). A peek that errors prints no line (→ unknown).
 */
export function peekScript(migs) {
  const lines = [];
  for (const m of migs) {
    lines.push(`select ${sqlString(m.file + "|")} || coalesce((${m.peek})::text, 'null');`);
    if (m.rest) lines.push(`select ${sqlString(m.file + "#rest|")} || coalesce((${m.rest})::text, 'null');`);
  }
  return lines.join("\n") + "\n";
}
/** One order everywhere (file names, code-unit order — what `ls`/sort() and the deploy MIGS order use). */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** psql -tA output → Map "file" / "file#rest" → "true" | "false" | "null". */
export function parsePeekOutput(text) {
  const map = new Map();
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\d{14}_[^|#]+\.sql(?:#rest)?)\|(true|false|null)$/.exec(l.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * THE deploy rule (R-2480's plan() in supabase/cloudsql/<env>/deploy-db-*.sh), for the local DB.
 * tests/ops/localhost-update-superseded.test.ts runs that bash plan() and this one on the same answers
 * and requires the same state for every key, so the two cannot drift.
 *
 * migs: [{ file, key, status: "applied" | "pending" | "unknown", later: [keys], restAnswer: "true" | "false" |
 *          "null" | undefined (the rest peek's answer; undefined = no rest check / no answer), defines }].
 * accept: keys (or file names) that count as superseded when blocked — the deploy script's
 *          ACCEPT_SUPERSEDED, for a later migration that on purpose removed what an older peek checks.
 * Newest first, per migration:
 *   in         — peek true (status applied);
 *   superseded — peek false, a LATER redefiner is in (or itself superseded) and rest is true: not re-run;
 *   blocked    — a later redefiner is in but rest is not true: re-running brings the old body back,
 *                skipping loses its other parts. The deploy script stops here; locally see `repair`;
 *   apply      — anything else (no later redefiner in): applied in file order.
 * Local only (no bash counterpart: the deploy script stops on a key with NO answer, and reads a null
 * answer as "not in" → apply): status "unknown" (peek null/error) is never applied here, and an older migration whose only later redefiner(s)
 * are unknown is held (skip) rather than applied over a body that may be newer.
 *
 * repair (local only, `--repair`): a blocked migration IS applied in file order, and then the newest
 * migration (already in) defining each function/view it overwrote is re-run — the WHOLE file (its
 * backfills and grants too; deploy migrations are written re-runnable), so every function/view ends on its
 * newest body. A re-run file's own objects are followed the same way. Only functions/views are followed:
 * a grant/policy/trigger the old file sets and a later file changed WITHOUT redefining one of its
 * functions is not restored. If a newest definer is not in (unknown/held), the whole repair is refused.
 * Not one transaction (migrations carry their own begin/commit): a failing re-run stops with exit 3 and
 * names the file — run --dry-run --repair first.
 *
 * → { state: Map key → { st, by }, apply: [file] (ascending; with repair also the blocked + re-run files),
 *     skip: [{ file, reason }], blocked: [{ file, key, by, byFile }], rerun: [file], repairStops: [{ file, reason }],
 *     unknown: [file], applied: n }
 */
export function planMigrations(migs, { repair = false, accept = [] } = {}) {
  const sorted = [...migs].sort((a, b) => byName(a.file, b.file));
  const accepted = new Set(accept);
  const byKey = new Map(sorted.map((m) => [m.key, m]));
  const fileOf = (k) => byKey.get(k)?.file ?? k;
  const state = new Map();
  const skip = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m.status === "applied") { state.set(m.key, { st: "in", by: "" }); continue; }
    if (m.status === "unknown") { state.set(m.key, { st: "unknown", by: "" }); continue; }
    let by = "", held = "";
    for (const later of m.later ?? []) { /* name a later one that is IN, else one itself superseded */
      const st = state.get(later)?.st;
      if (st === "in") { by = later; break; }
      if (st === "superseded" && !by) by = later;
      if ((st === "unknown" || st === "held") && !held) held = later;
    }
    if (!by && held) {
      state.set(m.key, { st: "held", by: held });
      skip.push({ file: m.file, reason: `later ${fileOf(held)} ka peek unknown (ya woh khud ruka) — chalane se uski shayad nayi body mit jaati; NAHI lagaya` });
    } else if (!by) state.set(m.key, { st: "apply", by: "" });
    else if (m.restAnswer === "true") {
      state.set(m.key, { st: "superseded", by });
      skip.push({ file: m.file, reason: `superseded by ${fileOf(by)} (woh lagi hui hai, aur is file ke baaki hisse bhi) — chalane se purani body wapas aa jaati` });
    } else if (accepted.has(m.key) || accepted.has(m.file)) {
      state.set(m.key, { st: "superseded", by: `${by} (ACCEPT_SUPERSEDED)` });
      skip.push({ file: m.file, reason: `superseded by ${fileOf(by)} (ACCEPT_SUPERSEDED — aapne jaanch ke maana) — baaki hisse nahi hain, jaan-boojh kar` });
    } else state.set(m.key, { st: "blocked", by });
  }
  const blocked = sorted.filter((m) => state.get(m.key).st === "blocked").map((m) => ({ file: m.file, key: m.key, by: state.get(m.key).by, byFile: fileOf(state.get(m.key).by) }));
  const apply = new Set(sorted.filter((m) => state.get(m.key).st === "apply").map((m) => m.file));
  const rerun = new Set();
  const repairStops = [];
  if (repair) {
    const newestDefiner = (obj) => { for (let j = sorted.length - 1; j >= 0; j--) if ((sorted[j].defines ?? []).includes(obj)) return sorted[j]; return null; };
    const blockedFiles = new Set(blocked.map((b) => b.file));
    for (const b of blocked) {
      const add = [];
      const queue = [byKey.get(b.key)];
      let stop = null;
      while (queue.length && !stop) {
        const cur = queue.shift();
        for (const obj of cur.defines ?? []) {
          const n = newestDefiner(obj);
          if (!n || n.file <= cur.file || apply.has(n.file) || blockedFiles.has(n.file) || add.includes(n.file) || rerun.has(n.file)) continue;
          if (state.get(n.key).st !== "in") { stop = `${obj} ki nayi body ${n.file} me hai, par woh lagi hui nahi (${state.get(n.key).st}) — haath se jaancho`; break; }
          add.push(n.file);
          queue.push(n);
        }
      }
      if (stop) { repairStops.push({ file: b.file, reason: stop }); continue; } /* runUpdate then runs nothing */
      apply.add(b.file);
      for (const f of add) rerun.add(f);
    }
    for (const f of rerun) apply.add(f);
  }
  return {
    state,
    apply: [...apply].sort(byName),
    skip: skip.sort((a, b) => byName(a.file, b.file)),
    blocked,
    rerun: [...rerun].sort(byName),
    repairStops,
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
  const out = { dryRun: false, repair: false, accept: [], dir: null, to: TARGET, noFetch: false, port: 3001, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--no-fetch") out.noFetch = true;
    else if (a === "--repair") out.repair = true;
    else if (a === "--accept-superseded") out.accept.push(...String(argv[++i] ?? "").split(/[\s,]+/).filter(Boolean));
    else if (a === "--port") out.port = Number(argv[++i]) || 3001;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument ${a} (--dry-run / --repair / --accept-superseded <keys> / --dir <checkout> / --to <ref> / --no-fetch / --port <n>)`);
  }
  return out;
}

/* ───────────── the run (git + psql injected) ───────────── */

/**
 * git(args) → stdout (throws on a non-zero exit); psql(sql, { stopOnError }) → { status, out } or null when no
 * local DB; writeFile(path, text) for the backup patch. Returns { code, lines }.
 */
export function runUpdate({ git, psql, print = () => {}, dryRun = false, repair = false, accept = [], to = TARGET, noFetch = false, port = 3001, tmpDir = os.tmpdir(), writeFile = (p, t) => fs.writeFileSync(p, t), readFile = null, now = () => new Date() }) {
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
  /* R-2484: the deploy scripts' own data (widened peeks, later redefiners, rest peeks) from gen-deploy-db. */
  const migs = deployEntries(names.map((f) => ({ file: f, sql: readFile ? readFile(ref, `${MIGRATIONS_DIR}/${f}`) : git(["show", `${ref}:${MIGRATIONS_DIR}/${f}`]) })));
  const r = psql ? psql(peekScript(migs), { stopOnError: false }) : null;
  if (!r) {
    say("! Local DB (docker supabase_db_*) nahi mila — migrations jaanche/lagaye NAHI. `npx supabase start`, phir dobara.");
    finish(say, { changed, port, kept, git });
    return done(EXIT.noDb);
  }
  const peeks = parsePeekOutput(r.out);
  for (const m of migs) {
    const v = peeks.get(m.file);
    m.status = v === "true" ? "applied" : v === "false" ? "pending" : "unknown";
    m.restAnswer = m.rest ? peeks.get(`${m.file}#rest`) ?? "null" : undefined;
  }
  const plan = planMigrations(migs, { repair, accept });
  say(`Migrations (deploy-peek wale ${migs.length}): ${plan.applied} lage hue, ${plan.apply.length} lagane, ${plan.skip.length} superseded/ruke, ${plan.blocked.length} blocked, ${plan.unknown.length} peek unknown`);
  for (const s of plan.skip) say(`  skip ${s.file} — ${s.reason}`);
  for (const u of plan.unknown) say(`  ? ${u} — peek error/null; NAHI lagaya (haath se jaancho)`);
  /* Blocked (R-2480's deploy rule): a newer redefiner is in, but this file's other parts are not. */
  if (plan.blocked.length && (!repair || plan.repairStops.length)) {
    say(`✗ BLOCKED (deploy rule R-2480) — in migrations ki nayi body lagi hui hai par inke baaki hisse (column/table/doosre functions) NAHI:`);
    for (const b of plan.blocked) say(`   ${b.file} (nayi: ${b.byFile}; key ${b.key})`);
    for (const s of plan.repairStops) say(`   ! repair nahi ho sakta: ${s.file} — ${s.reason}`);
    say("   Dobara chalane se purani body wapas aati, chhodne se hissa gayab rehta. Koi migration NAHI lagi.");
    if (!plan.repairStops.length) say("   Local DB theek karo: npm run localhost:update -- --repair   (pehle -- --dry-run --repair se dekho: ye file order me lagegi, phir har function/view ki sabse nayi body dobara chalegi)");
    say("   Ya agar baad wali migration ne woh hissa JAAN-BOOJH kar hataya: -- --accept-superseded <key,key> (deploy ka ACCEPT_SUPERSEDED).");
    finish(say, { changed, port, kept, git });
    return done(EXIT.blocked);
  }
  const rerun = new Set(plan.rerun);
  if (repair && plan.blocked.length) say(`  --repair: ${plan.blocked.map((b) => b.file).join(", ")} lagegi; nayi body ke liye dobara: ${plan.rerun.join(", ") || "—"}`);
  let code = EXIT.ok;
  for (const f of plan.apply) {
    const m = migs.find((x) => x.file === f);
    if (dryRun) { say(`  [dry-run] ${rerun.has(f) ? "dobara chalata (nayi body)" : "lagata"}: ${f}`); continue; }
    const a = psql(m.sql, { stopOnError: true });
    if (a.status !== 0) { say(`✗ ${f} FAIL — ruk gaye (baaki nahi lage):\n${String(a.out).trim().split("\n").slice(-6).join("\n")}`); code = EXIT.migrationFailed; break; }
    const after = parsePeekOutput(psql(peekScript([m]), { stopOnError: false })?.out).get(f);
    if (after !== "true") { say(`✗ ${f} chala par uska deploy-peek ab bhi ${after ?? "error"} — ruk gaye. Migration/peek jaancho.`); code = EXIT.migrationFailed; break; }
    say(`  ✓ ${rerun.has(f) ? "dobara chalaya (nayi body)" : "lagaya"}: ${f}`);
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
  if (args.help) { console.log("npm run localhost:update [-- --dry-run] [--repair] [--accept-superseded <keys>] [--dir <checkout>] [--to <ref>] [--port 3001]"); return; }
  const start = args.dir ? path.resolve(args.dir) : process.cwd();
  let top;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { console.error(`✗ ${start} git checkout nahi hai.`); process.exit(EXIT.refused); }
  console.log(`localhost:update → ${top}${args.dryRun ? "  (dry-run: kuch nahi badlega)" : ""}`);
  const git = (a) => execFileSync("git", a, { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  let r;
  try { r = runUpdate({ git, psql: realPsql(), print: (l) => console.log(l), dryRun: args.dryRun, repair: args.repair, accept: [...args.accept, ...String(process.env.ACCEPT_SUPERSEDED ?? "").split(/[\s,]+/).filter(Boolean)], to: args.to, noFetch: args.noFetch, port: args.port }); }
  catch (e) { console.error(`✗ ${String(e?.stderr ?? e?.message ?? e).slice(0, 800)}`); process.exit(EXIT.refused); }
  process.exit(r.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
