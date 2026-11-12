/**
 * R-2718 (12 Nov 2026): locks by FILE, not by folder.
 *
 * Before: a claimed folder was a hard lock on every file in it. R-2698 claimed accounting/payroll and
 * components/features/payroll; R-2701 then waited ~1 h for the slot queue to free those folders
 * although the two cards never touched the same file. The push rebase (exit 2 on a real conflict)
 * and `check` (before every commit) were always the real guards — a whole-folder claim only blocked
 * cards that would have been fine.
 *
 * Now (lock `lockVersion: 2`, written by claim, with `folders` = the claimed paths that are folders):
 *   - a FILE in the claim is a hard lock (as before);
 *   - a FOLDER in the claim is "soft": it still sets the card's scope (R-1958 — what the card may
 *     change) but blocks another card only through the files this card has REALLY changed in it —
 *     `files` (grown by every `check`, and by push) plus the worktree's live `git diff`/`git status`.
 *     If that live read fails (git error / timeout), the soft folders count as hard (fail closed);
 *   - `claim … --move <folder>` = the card renames / moves / deletes that folder: a hard folder lock
 *     (it clashes with any file or folder another card holds inside it, soft folders included).
 * So two cards editing DIFFERENT files in the same folder both claim; the second card to touch a
 * file the other already changed (or claimed as a file) is refused at `check` (exit 2), before it
 * commits — the same place a file outside the claim was always caught.
 *
 * Backward compatible: a lock without `lockVersion` (claimed by older worker-lock code, or before
 * this change) keeps the old meaning — every claimed path, folders included, is hard, and a new soft
 * folder overlapping it is refused as before — so a card that is already running keeps the whole
 * folders it was promised (a re-claim of such a lock stays old). An older worker-lock reading a v2
 * lock sees its folders in `areas` and treats them as hard: stricter, never looser.
 * Generated files (deploy-db-*.sh, peeks.generated.ts — R-2105) stay out of every lock as before.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claimPath as norm } from "./worker-lock-guards.mjs";

export const LOCK_VERSION = 2;

/** By name only: the last part has an extension, or is a dotfile like .env.example. Used when the disk can't tell. */
export function isFileArea(p) {
  const parts = norm(p).split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  return /^[^.].*\.[a-z0-9]{1,8}$|^\..+\..+$/i.test(last);
}

/**
 * At claim: which claimed paths are FOLDERS. The worktree decides when the path exists there (so a
 * Dockerfile / .gitignore is a file, src/app/api/x/[id] a folder); a path not created yet goes by name.
 */
export function claimFolders(areas, worktree, { stat = (p) => fs.statSync(p) } = {}) {
  const app = worktree ? path.join(worktree, "production") : null;
  return areas.map(norm).filter((a) => {
    if (app) {
      for (const full of [path.join(app, a), path.join(worktree, a)]) {
        try { return stat(full).isDirectory(); } catch {}
      }
    }
    return !isFileArea(a);
  });
}

/** True for a lock written by R-2718+ claim (soft folders). */
export function isFileLock(lock) { return Number(lock?.lockVersion ?? 1) >= LOCK_VERSION; }

/** Folders this lock renames/moves (hard). */
export function movesOf(lock) { return (Array.isArray(lock?.moves) ? lock.moves : []).map(norm); }

/** A v2 lock's claimed folders (its `folders` list; by name for a lock written without it). */
function foldersOf(lock) {
  const areas = (lock?.areas ?? []).map(norm);
  return Array.isArray(lock?.folders) ? lock.folders.map(norm) : areas.filter((a) => !isFileArea(a));
}

/** The soft folders of a v2 lock (claimed folders that are not --move). Old locks: none (all hard). */
export function softFolders(lock) {
  if (!isFileLock(lock)) return [];
  const moves = new Set(movesOf(lock));
  return foldersOf(lock).filter((a) => !moves.has(a));
}

/**
 * The paths of `lock` that block other cards. `live` = the files its worktree has changed right now,
 * or null when they could not be read — then its soft folders count as hard (fail closed).
 * Old lock (no lockVersion): every claimed area + files — exactly as before.
 */
export function hardPaths(lock, live = []) {
  const areas = (lock?.areas ?? []).map(norm), files = (lock?.files ?? []).map(norm);
  if (!isFileLock(lock)) return [...areas, ...files];
  const folders = new Set(foldersOf(lock));
  const unread = live === null ? softFolders(lock) : [];
  return [...new Set([...areas.filter((a) => !folders.has(a)), ...movesOf(lock), ...files, ...(live ?? []).map(norm), ...unread])];
}

/** What MY new claim holds hard: its files and its --move folders (its other folders are soft). */
export function claimHardPaths(areas, moves = [], folders = areas.filter((a) => !isFileArea(a))) {
  const f = new Set(folders.map(norm));
  return [...new Set([...areas.map(norm).filter((a) => !f.has(a)), ...moves.map(norm)])];
}

/** `--move <folder>` (repeatable) out of the claim args. */
export function parseMoveFlags(args) {
  const rest = [], moves = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--move") { if (args[i + 1] != null) moves.push(norm(args[++i])); }
    else if (a.startsWith("--move=")) moves.push(norm(a.slice(7)));
    else rest.push(a);
  }
  return { rest, moves };
}

/**
 * The files a worktree has changed against anutech/manager-pardeep right now (committed since the
 * merge-base + uncommitted + untracked), app-relative. [] when the folder is gone (a pushed card's
 * cleaned-up worktree — its recorded `files` count); null when git fails or times out (caller fails
 * closed). `--no-optional-locks`: never take the other worker's index.lock (its own commit could fail).
 */
export function worktreeChangedFiles(worktree, { git } = {}) {
  if (!worktree) return [];
  if (!git && !fs.existsSync(worktree)) return [];
  const run = git ?? ((args) => execFileSync("git", ["--no-optional-locks", "-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }));
  try {
    const base = run(["merge-base", "HEAD", "anutech/manager-pardeep"]).trim();
    const committed = run(["diff", "--name-only", "--no-renames", base, "HEAD"]).split("\n");
    const working = run(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop());
    return [...new Set([...committed, ...working].map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).map(norm))];
  } catch { return null; }
}

/** One look per command: each other lock's worktree is read once (claim --wait looks every 15 s → 30 s memo). */
export function liveFilesReader({ read = worktreeChangedFiles, ttlMs = 30_000, now = () => Date.now() } = {}) {
  const memo = new Map();
  return (lock) => {
    if (!isFileLock(lock) || !lock?.worktree) return [];
    const hit = memo.get(lock.worktree);
    if (hit && now() - hit.at < ttlMs) return hit.files;
    const files = read(lock.worktree);
    memo.set(lock.worktree, { at: now(), files });
    return files;
  };
}
