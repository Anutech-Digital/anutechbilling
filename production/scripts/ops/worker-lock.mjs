#!/usr/bin/env node
/**
 * Worker locks — two worker sessions must never build in the same files (6 Oct 2026).
 *
 * Pardeep: "dhyan rakhne wali baat ka koi aisa solid system banao ki ye galti na ho paye".
 * Every worker session (docs/WORKER-SESSION-PROMPT.md) runs on this one machine, so a lock
 * file per card in ~/.claude/worker-locks is something every worker can see. Two checks:
 *
 *   claim  — before any code: the folders/files the card will touch. Refused if another
 *            live worker already holds an overlapping path.
 *   check  — before every commit/push: the files ACTUALLY changed in this worktree. Catches
 *            the card that turned out to touch more than it claimed. Adds them to the lock.
 *
 * A lock whose worktree folder is gone is stale (session crashed or cleaned up) and is
 * removed automatically, so a dead session cannot block the queue forever.
 *
 *   node scripts/ops/worker-lock.mjs claim   R-197 C:/Users/mso50/reselleros-w-r-197 src/app/(app)/deals src/lib/deals
 *   node scripts/ops/worker-lock.mjs check   R-197      (run inside the worktree)
 *   node scripts/ops/worker-lock.mjs release R-197
 *   node scripts/ops/worker-lock.mjs list
 *
 * Exit 0 = go. Exit 2 = conflict (message names the other card). Exit 3 = MAX_WORKERS (4) already
 * running. Either way: stop, do not work around it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LOCK_DIR = process.env.WORKER_LOCK_DIR || path.join(os.homedir(), ".claude", "worker-locks");

/** "production/src/x/" and "src\\x" both become "src/x" — paths are compared from the app root. */
export function normPath(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s.startsWith("production/")) s = s.slice("production/".length);
  return s;
}

/** Same path, or one is a folder holding the other. "src/lib/deal" does NOT overlap "src/lib/deals". */
export function pathsOverlap(a, b) {
  const x = normPath(a), y = normPath(b);
  return x === y || y.startsWith(x + "/") || x.startsWith(y + "/");
}

/** A claim like "src" or "src/app" would lock out every other worker — refuse it. */
export function tooBroad(area) {
  return normPath(area).split("/").filter(Boolean).length < 3;
}

/** Most workers allowed at once. 6 Oct 2026: 8 at once left 2 GB of 24 GB free and hung the machine. */
export const MAX_WORKERS = Number(process.env.WORKER_MAX || 4);

/** True when another worker may not start: the live locks (other cards) already fill every slot. */
export function queueFull(card, locks, max = MAX_WORKERS) {
  return locks.filter((l) => l.card !== card).length >= max;
}

/** Every pair of overlapping paths between my claims and other live locks. */
export function findConflicts(card, mine, locks) {
  const out = [];
  for (const l of locks) {
    if (l.card === card) continue;
    const theirs = [...(l.areas ?? []), ...(l.files ?? [])];
    for (const m of mine) for (const t of theirs) {
      if (pathsOverlap(m, t)) out.push({ card: l.card, mine: normPath(m), theirs: normPath(t) });
    }
  }
  return out;
}

function lockFile(card) { return path.join(LOCK_DIR, `${card.toUpperCase()}.json`); }

export function readLocks() {
  if (!fs.existsSync(LOCK_DIR)) return [];
  const live = [];
  for (const f of fs.readdirSync(LOCK_DIR).filter((n) => n.endsWith(".json"))) {
    const full = path.join(LOCK_DIR, f);
    let l;
    try { l = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (!l.worktree || !fs.existsSync(l.worktree)) {
      fs.rmSync(full, { force: true });
      console.log(`(stale lock ${l.card ?? f} removed — its worktree folder is gone)`);
      continue;
    }
    live.push(l);
  }
  return live;
}

function report(conflicts) {
  console.error("✗ TAKRAAV — dusra worker inhi files par kaam kar raha hai:");
  for (const c of conflicts) console.error(`   ${c.card}: ${c.theirs}   ↔   tumhara: ${c.mine}`);
  console.error("Ruko. Owner ko batao: \"" + [...new Set(conflicts.map((c) => c.card))].join(", ") +
    " khatam hone ke baad ye card chalaiye, ya koi aur card dijiye.\" Lock ko haath mat lagao.");
  process.exit(2);
}

function changedFiles() {
  const base = execSync("git merge-base HEAD anutech/manager-pardeep", { encoding: "utf8" }).trim();
  const committed = execSync(`git diff --name-only ${base} HEAD`, { encoding: "utf8" });
  const working = execSync("git status --porcelain --untracked-files=all", { encoding: "utf8" })
    .split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop());
  return [...new Set([...committed.split("\n"), ...working].map((s) => s.trim()).filter(Boolean).map(normPath))];
}

function main(argv) {
  const [cmd, rawCard, ...rest] = argv;
  const card = rawCard?.toUpperCase();
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  if (cmd === "list") {
    const locks = readLocks();
    if (!locks.length) return console.log("Koi worker lock nahi.");
    for (const l of locks) console.log(`${l.card}  ${l.claimedAt}  ${[...l.areas, ...(l.files ?? [])].join("  ")}`);
    return;
  }
  if (!card || !/^R-\d+$/.test(card)) { console.error("Card id do, jaise R-197"); process.exit(1); }

  if (cmd === "claim") {
    const [worktree, ...areas] = rest;
    if (!worktree || !areas.length) { console.error("claim <CARD> <worktree> <folder/file>..."); process.exit(1); }
    const broad = areas.filter(tooBroad);
    if (broad.length) { console.error(`✗ Bahut bada area: ${broad.join(", ")} — page/lib ka folder ya file do (kam se kam 3 hisse, jaise src/lib/deals).`); process.exit(1); }
    const locks = readLocks();
    if (queueFull(card, locks)) {
      console.error(`✗ PEHLE SE ${MAX_WORKERS} WORKER chal rahe hain (${locks.map((l) => l.card).join(", ")}) — computer hang na ho, isliye ruko.`);
      console.error("Owner ko batao: \"Ek worker khatam hone ke baad ye card chalaiye.\" Lock ko haath mat lagao.");
      process.exit(3);
    }
    const conflicts = findConflicts(card, areas, locks);
    if (conflicts.length) report(conflicts);
    fs.writeFileSync(lockFile(card), JSON.stringify({ card, worktree: path.resolve(worktree), areas: areas.map(normPath), files: [], claimedAt: new Date().toISOString() }, null, 2));
    console.log(`✓ ${card} ka lock laga: ${areas.map(normPath).join(", ")}`);
    return;
  }
  if (cmd === "check") {
    const f = lockFile(card);
    if (!fs.existsSync(f)) { console.error(`✗ ${card} ka lock nahi hai — pehle claim chalao.`); process.exit(1); }
    const me = JSON.parse(fs.readFileSync(f, "utf8"));
    const files = changedFiles();
    const conflicts = findConflicts(card, files, readLocks());
    if (conflicts.length) report(conflicts);
    me.files = [...new Set([...(me.files ?? []), ...files])];
    fs.writeFileSync(f, JSON.stringify(me, null, 2));
    console.log(`✓ ${files.length} badli files — kisi aur worker se takraav nahi.`);
    return;
  }
  if (cmd === "release") {
    fs.rmSync(lockFile(card), { force: true });
    console.log(`✓ ${card} ka lock hata.`);
    return;
  }
  console.error("claim | check | release | list");
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
