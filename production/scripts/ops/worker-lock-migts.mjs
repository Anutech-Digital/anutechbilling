/**
 * R-2614 (8 Nov 2026) — migration timestamps stop costing re-reviews and push retries.
 *
 * 8 Nov: R-2604 was renamed 3 times, R-2609 and R-2613 collided on 20261108133000, R-2611 needed a
 * rename. Every rename made a new sha, so the R-2592 review gate asked for a new independent review
 * each time (5+ extra reviews, ~2 h of push delay), and each rename was done by hand. Now:
 *
 *   push   — when CI's migration-order check fails ONLY because this card's own new migration(s) are
 *            not newer than manager-pardeep's newest (or share a version with one there), worker-lock
 *            renames them itself to the current UTC time (all of the card's new migrations, order
 *            kept), rewrites the old name in the card's own changed files, regenerates deploy-db +
 *            peeks, commits "<CARD>: rename migration (auto)" and goes on with the push.
 *   review — the patch-id the review gate compares is taken with the card's OWN new migration versions
 *            masked (R-2615: only versions of files the diff ADDS under supabase/migrations/, and their
 *            exact mentions — never any other 14-digit number), and docs/API.md left out like the other
 *            generated files, so a rename-only or regen-only change keeps the SAFE review. Any other code
 *            change — including one that only changes some other 20YYMMDDHHMMSS-looking number — does not.
 *   claim / check — refuse when another active lock's worktree, or a recent anutech wip/<card> branch,
 *            holds a new migration with the same timestamp as one of this card's. R-2615: never my own
 *            wip branch, and not a wip migration that the same card renamed later (a newer file with the
 *            same name part on manager-pardeep, added by a commit naming that card).
 *
 * `git` is injected ((args, input?) => stdout, run at the repo top; throws on non-zero) so tests drive
 * this with a real throwaway repo.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const MIG_DIR = "production/supabase/migrations"; // repo-root relative, as git sees it
export const MIG_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const STAMP = /(?<!\d)20\d{12}(?!\d)/g;
export const STAMP_MASK = "YYYYMMDDHHMMSS";

/** Every 14-digit 20… number masked. R-2614's review mask — too wide (R-2615); kept for old callers, the gate uses maskOwnMigrations. */
export function maskMigrationStamps(text) {
  return String(text ?? "").replace(STAMP, STAMP_MASK);
}

/** R-2615: versions of the migrations a unified diff ADDS under supabase/migrations/ (sorted, unique). */
export function ownMigrationVersions(diff) {
  const out = new Set();
  for (const sec of String(diff ?? "").split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/\S+ b\/(\S+)\r?\n/.exec(sec);
    if (!head || !/(^|\/)supabase\/migrations\/[^/]+$/.test(head[1])) continue;
    const end = sec.search(/^(@@|---|Binary)/m);
    if (!/^new file mode /m.test(end < 0 ? sec : sec.slice(0, end))) continue;
    const v = MIG_NAME.exec(head[1].split("/").pop())?.[1];
    if (v) out.add(v);
  }
  return [...out].sort();
}

/**
 * R-2615: the review gate's mask — each of the card's OWN new migration versions (ownMigrationVersions)
 * becomes MIGRATION_<i> (i = its place among them, so a rename that keeps their order is invisible),
 * wherever that exact version appears. Every other number stays as it is.
 */
export function maskOwnMigrations(diff) {
  let s = String(diff ?? "");
  ownMigrationVersions(s).forEach((v, i) => { s = s.replace(new RegExp(`(?<!\\d)${v}(?!\\d)`, "g"), `MIGRATION_${i}`); });
  return s;
}

/** Current UTC time as YYYYMMDDHHMMSS. */
export function utcStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

const plusOne = (ts) => String(BigInt(ts) + 1n).padStart(14, "0");

/** The problem lines of migration-order-check's output (after "Migration check FAILED:"). */
export function orderProblems(out) {
  const s = String(out ?? "");
  const i = s.indexOf("Migration check FAILED:");
  if (i < 0) return [];
  return s.slice(i + "Migration check FAILED:".length).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Is the order check red ONLY because of the card's own new migrations being too old / sharing a
 * version? `own` = file names this card ADDED (not on the base). → { ok, late: [names] } or
 * { ok: false, why }. Any other problem (edited/renamed/deleted migration, bad name, someone else's
 * file) → not ours to fix automatically.
 */
export function ownLateOnly(problems, own) {
  const mine = new Set(own ?? []);
  const late = new Set();
  if (!problems?.length) return { ok: false, why: "no problem lines" };
  for (const p of problems) {
    const o = /^out of order: (\S+\.sql) is not newer than (\d{14})/.exec(p);
    if (o) { if (!mine.has(o[1])) return { ok: false, why: p }; late.add(o[1]); continue; }
    const d = /^duplicate version (\d{14}): (\S+\.sql) and (\S+\.sql)$/.exec(p);
    if (d) {
      const hit = [d[3], d[2]].find((f) => mine.has(f));
      if (!hit) return { ok: false, why: p };
      late.add(hit); continue;
    }
    return { ok: false, why: p };
  }
  return { ok: true, late: [...late] };
}

/**
 * New names for ALL of the card's own new migrations (sorted, so their order among themselves stays):
 * consecutive timestamps from now (UTC), each newer than `newestOnBase` and not in `taken`
 * (other cards' / files' versions). → [{ from, to }] (only entries whose name changes).
 */
export function planRenames(own, { newestOnBase = "0", now = Date.now(), taken = [] } = {}) {
  const used = new Set(taken);
  let ts = utcStamp(now);
  if (ts <= newestOnBase) ts = plusOne(newestOnBase);
  const out = [];
  for (const from of [...own].sort()) {
    const m = MIG_NAME.exec(from);
    if (!m) continue;
    while (used.has(ts)) ts = plusOne(ts);
    used.add(ts);
    const to = `${ts}_${m[2]}.sql`;
    if (to !== from) out.push({ from, to });
    ts = plusOne(ts);
  }
  return out;
}

/** Old stem / bare version → new, in one text. */
export function rewriteMentions(text, renames) {
  let s = String(text);
  for (const { from, to } of renames) {
    s = s.split(from.replace(/\.sql$/, "")).join(to.replace(/\.sql$/, ""));
    const a = MIG_NAME.exec(from)[1], b = MIG_NAME.exec(to)[1];
    s = s.replace(new RegExp(`(?<!\\d)${a}(?!\\d)`, "g"), b);
  }
  return s;
}

const isGenerated = (f) => /(^|\/)supabase\/cloudsql\/(staging|live)\/deploy-db-[^/]+\.sh$/.test(f)
  || /(^|\/)src\/server\/migrations-health\/peeks\.generated\.ts$/.test(f) || f === "docs/API.md";

/** Migration file names this checkout ADDED against `base` (committed since the merge-base + untracked). */
export function addedMigrations(git, base = "anutech/manager-pardeep") {
  const names = new Set();
  let mb = null;
  try { mb = git(["merge-base", base, "HEAD"]).trim(); } catch { return { mb: null, added: [], onBase: [] }; }
  let onBase = [];
  try { onBase = git(["ls-tree", "--name-only", `${base}:${MIG_DIR}`]).split(/\r?\n/).filter((f) => MIG_NAME.test(f)); } catch {}
  const baseSet = new Set(onBase);
  for (const l of git(["diff", "--name-status", "--no-renames", "--diff-filter=A", mb, "HEAD", "--", MIG_DIR]).split(/\r?\n/)) {
    const f = l.split("\t")[1]?.split("/").pop();
    if (f && MIG_NAME.test(f) && !baseSet.has(f)) names.add(f);
  }
  for (const l of git(["status", "--porcelain", "--untracked-files=all", "--", MIG_DIR]).split(/\r?\n/)) {
    if (!l.startsWith("??") && !l.startsWith("A")) continue;
    const f = l.slice(3).trim().replace(/^"|"$/g, "").split("/").pop();
    if (f && MIG_NAME.test(f) && !baseSet.has(f)) names.add(f);
  }
  return { mb, added: [...names].sort(), onBase };
}

/**
 * Push step: run the order check; red ONLY from the card's own late migrations → rename them, rewrite
 * mentions in the card's changed files, regenerate, commit, check again.
 * deps: { git, top, runCheck: () => ({status, out}), regen: () => void, now, taken: [versions] or () => [versions], print }
 * → { ok, renamed: [{from,to}], why? }
 */
export function autoRenameLateMigrations(card, { git, top, runCheck, regen = () => {}, now = Date.now(), taken = [], print = () => {}, base = "anutech/manager-pardeep" }) {
  const id = String(card).toUpperCase();
  const first = runCheck();
  if (first.status === 0) return { ok: true, renamed: [] };
  const { mb, added, onBase } = addedMigrations(git, base);
  const verdict = ownLateOnly(orderProblems(first.out), added);
  if (!verdict.ok) return { ok: false, renamed: [], why: verdict.why };
  const newestOnBase = onBase.map((f) => MIG_NAME.exec(f)[1]).sort().at(-1) ?? "0";
  const inTree = (() => { try { return fs.readdirSync(path.join(top, MIG_DIR)).map((f) => MIG_NAME.exec(f)?.[1]).filter(Boolean); } catch { return []; } })();
  const mineStamps = new Set(added.map((f) => MIG_NAME.exec(f)[1]));
  const others = typeof taken === "function" ? taken() : taken;
  const renames = planRenames(added, { newestOnBase, now, taken: [...others, ...inTree.filter((v) => !mineStamps.has(v))] });
  if (!renames.length) return { ok: false, renamed: [], why: "nothing to rename" };
  const changed = git(["diff", "--name-only", "--no-renames", mb, "HEAD"]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const { from, to } of renames) git(["mv", `${MIG_DIR}/${from}`, `${MIG_DIR}/${to}`]);
  const renamedTo = new Map(renames.map((r) => [`${MIG_DIR}/${r.from}`, `${MIG_DIR}/${r.to}`]));
  const touched = [];
  for (const f0 of changed) {
    const f = renamedTo.get(f0) ?? f0;
    if (isGenerated(f)) continue;
    const abs = path.join(top, f);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue;
    const before = buf.toString("utf8"), after = rewriteMentions(before, renames);
    if (after !== before) { fs.writeFileSync(abs, after); touched.push(f); }
  }
  if (touched.length) git(["add", "--", ...touched]);
  regen();
  const regenDirs = [MIG_DIR, "production/supabase/cloudsql", "production/src/server/migrations-health"].filter((d) => fs.existsSync(path.join(top, d)));
  git(["add", "-A", "--", ...regenDirs]);
  const list = renames.map((r) => `${r.from} -> ${r.to}`).join(", ");
  git(["commit", "-q", "--no-verify", "-m", `${id}: rename migration (auto) ${list}\n\nworker-lock push (R-2614): the card's own new migration was not newer than anutech/manager-pardeep's newest; renamed to the current UTC time, mentions updated (${touched.length} file(s)), deploy-db + peeks regenerated.`]);
  print(`  ${id}: migration ka naam khud badla (auto, R-2614): ${list}; ${touched.length} file me naam badla; deploy-db/peeks dobara bane; commit "rename migration (auto)".`);
  const again = runCheck();
  return { ok: again.status === 0, renamed: renames, why: again.status === 0 ? undefined : orderProblems(again.out).join("; ") };
}

/** Same version held by me and by another card → [{ version, mine, other, card }]. others: [{card, files}] */
export function migrationClashes(mine, others) {
  const out = [];
  const byStamp = new Map((mine ?? []).map((f) => [MIG_NAME.exec(f)?.[1], f]).filter(([v]) => v));
  for (const o of others ?? []) {
    for (const f of o.files ?? []) {
      const v = MIG_NAME.exec(f)?.[1];
      if (v && byStamp.has(v)) out.push({ version: v, mine: byStamp.get(v), other: f, card: o.card });
    }
  }
  return out;
}

export function clashMessage(card, clashes) {
  return [
    `✗ ${String(card).toUpperCase()}: migration ka timestamp doosre card ke paas bhi hai (R-2614) — dono push nahi ho sakte:`,
    ...clashes.map((c) => `   ${c.version}: mera ${c.mine}  ↔  ${c.card} ka ${c.other}`),
    `   Apni migration ka naam abhi ke UTC time se badlo (date -u +%Y%m%d%H%M%S), naam ke mentions bhi, phir gen-deploy-db.`,
  ].join("\n");
}

/** Real git at a directory (repo top found from it). */
export function gitAt(dir) {
  return (args, input) => execFileSync("git", args, { cwd: dir, encoding: "utf8", input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Other cards' new migrations: active locks' worktrees + anutech wip/* branches committed in the last `days`. */
export function otherCardsMigrations(card, locks, { git, days = 3, gitFor = gitAt, exists = fs.existsSync, base = "anutech/manager-pardeep" } = {}) {
  const id = String(card).toUpperCase();
  const out = [], seen = new Set([id]);
  for (const l of locks ?? []) {
    if (!l?.card || seen.has(l.card) || !l.worktree || !exists(l.worktree)) continue;
    seen.add(l.card);
    try { out.push({ card: l.card, files: addedMigrations(gitFor(l.worktree), base).added }); } catch {}
  }
  let refs = [];
  try { refs = git(["for-each-ref", `--format=%(refname:short)\t%(committerdate:unix)`, "refs/remotes/anutech/wip"]).split(/\r?\n/).filter(Boolean); } catch {}
  const since = Date.now() / 1000 - days * 86400;
  let onBase = new Set();
  try { onBase = new Set(git(["ls-tree", "--name-only", `${base}:${MIG_DIR}`]).split(/\r?\n/)); } catch {}
  /* R-2615: the wip branch still has the OLD name of a migration its card renamed later (auto rename,
     then merged): a newer file with the same name part on base, added by a commit that names the card. */
  const renamedLater = (c, f) => {
    const m = MIG_NAME.exec(f);
    const cardRe = new RegExp(`(?<![\\w-])${c}(?!\\d)`, "i");
    return [...onBase].some((b) => {
      const n = MIG_NAME.exec(b);
      if (!n || n[2] !== m[2] || n[1] <= m[1]) return false;
      try { return cardRe.test(git(["log", base, "--format=%s%n%b", "--diff-filter=A", "--", `${MIG_DIR}/${b}`])); } catch { return false; }
    });
  };
  for (const r of refs) {
    const [ref, at] = r.split("\t");
    const c = /wip\/(r-\d+)$/i.exec(ref)?.[1]?.toUpperCase();
    if (!c || seen.has(c) || Number(at) < since) continue;
    seen.add(c);
    try {
      const files = git(["diff", "--name-only", "--no-renames", "--diff-filter=A", `${base}...${ref}`, "--", MIG_DIR]).split(/\r?\n/)
        .map((f) => f.split("/").pop()).filter((f) => f && MIG_NAME.test(f) && !onBase.has(f) && !renamedLater(c, f));
      out.push({ card: c, files });
    } catch {}
  }
  return out;
}

/** claim / check: { ok, message?, clashes } for the worktree at `worktree`. Never throws. */
export function checkMigrationClash(card, worktree, locks, { gitFor = gitAt } = {}) {
  try {
    if (!worktree || !fs.existsSync(worktree)) return { ok: true, clashes: [] };
    const git = gitFor(worktree);
    const mine = addedMigrations(git).added;
    if (!mine.length) return { ok: true, clashes: [] };
    const clashes = migrationClashes(mine, otherCardsMigrations(card, locks, { git, gitFor }));
    return clashes.length ? { ok: false, clashes, message: clashMessage(card, clashes) } : { ok: true, clashes: [] };
  } catch { return { ok: true, clashes: [] }; }
}

/** Real deps for the push step (run from production/). */
export function realAutoRenameDeps(card, locks, { regen } = {}) {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = gitAt(top);
  /* only asked when a rename is needed (reads other worktrees + wip branches) */
  const taken = () => { try { return otherCardsMigrations(card, locks, { git }).flatMap((o) => o.files.map((f) => MIG_NAME.exec(f)?.[1]).filter(Boolean)); } catch { return []; } };
  const runCheck = () => {
    const p = spawnSync(process.execPath, ["scripts/migration-order-check.mjs", "--base", "anutech/manager-pardeep"], { encoding: "utf8" });
    return { status: p.status, out: `${p.stdout ?? ""}${p.stderr ?? ""}` };
  };
  return { git, top, runCheck, regen, taken, print: (l) => console.log(l) };
}
