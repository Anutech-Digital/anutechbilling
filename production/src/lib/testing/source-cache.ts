/**
 * R-2564 (7 Nov 2026) — one shared, always-fresh read cache for the repo-scan guard tests.
 *
 * Why: ~20 push-guard files each walk src/ (≈4,900 .ts/.tsx, 36 MB) or supabase/migrations (≈600
 * files, 11 MB) and read every file on their own. On this Windows laptop the cost is the file opens,
 * not the bytes: one src/ walk reads in ~3.7 s alone and 15–20 s in the push's fork pool while other
 * workers run tsc — the same thousands of opens, a dozen times over. A cpu profile of gen-deploy-db
 * showed the same (readFileUtf8 = 90 % of its time).
 *
 * How: `readSource(file)` stats the file and returns the text from a cache file in the OS temp folder
 * when its size, mtime AND ctime are unchanged since it was cached; otherwise it reads the disk and
 * updates the entry. An edit, checkout or rebase changes mtime/ctime and that file is read again
 * (ctime also catches a copy that kept the old mtime).
 * R-2582 (8 Nov 2026), "racy" entries: a stat is only proof when the file was already older than
 * RACY_MS when it was cached — a same-size rewrite inside one timestamp tick keeps size, mtime and
 * ctime (Cloud Build 56911293 served stale text this way). So an entry cached within RACY_MS of the
 * file's mtime/ctime is re-read and its bytes compared before use (git's racy-index rule); a later
 * re-read after the file has aged trusts it again for the rest of that process. Old files — nearly all
 * of src/ — stay on the stat-only fast path, so a scan always sees what is on disk NOW.
 * The cache is written once per test file (afterAll) via a temp file + rename, so a reader never sees
 * half a file; a failed write only costs speed. Format: one JSON index line, then the texts back to
 * back — a test reads one Buffer and decodes only the files it asks for (a 50 MB JSON.parse took
 * ~1 s per test file). Delete the folder any time: `<tmp>/reselleros-source-cache`.
 *
 * Test-only: imported by *.test.ts files (and test-only scanners), never by app code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll } from "vitest";
import { PRODUCTION_ROOT } from "./prisma-generated";

/** s/m/c = size, mtimeMs, ctimeMs at read time; r = Date.now() just before that read (R-2582);
    text decoded lazily from `buf`. */
type Entry = { s: number; m: number; c: number; r: number; buf?: Buffer; text?: string };
type IndexRow = [key: string, s: number, m: number, c: number, r: number, offset: number, length: number];

const MAGIC = "reselleros-source-cache v3";
/** R-2582: an entry read less than this long after the file's mtime may hide a same-tick rewrite. */
export const RACY_MS = 2000;
const isRacy = (e: Entry): boolean => e.r - Math.max(e.m, e.c) < RACY_MS;
export const SOURCE_CACHE_DIR = path.join(os.tmpdir(), "reselleros-source-cache");
/** One cache per checkout (each worktree has its own production/). */
export const SOURCE_CACHE_FILE = path.join(
  SOURCE_CACHE_DIR,
  `${crypto.createHash("sha1").update(PRODUCTION_ROOT.toLowerCase()).digest("hex").slice(0, 12)}-v3.bin`,
);

let cacheFile = SOURCE_CACHE_FILE;
let entries: Map<string, Entry> | null = null;
/** Keys this process read from disk (new or changed) — the only ones a flush has to add. */
let fresh = new Set<string>();

/** The cache file as entries; empty when missing, unreadable, another format or cut short. */
function readCacheFile(): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const all = fs.readFileSync(cacheFile);
    const nl = all.indexOf(10);
    const head = JSON.parse(all.subarray(0, nl).toString("utf8")) as { magic: string; rows: IndexRow[] };
    if (head.magic !== MAGIC) return out;
    const base = nl + 1;
    for (const [k, s, m, c, r, off, len] of head.rows) {
      if (base + off + len > all.length) return new Map(); // torn → trust nothing
      out.set(k, { s, m, c, r, buf: all.subarray(base + off, base + off + len) });
    }
  } catch { return new Map(); }
  return out;
}

function load(): Map<string, Entry> {
  if (!entries) entries = readCacheFile();
  return entries;
}

/** Key: path relative to production/, forward slashes, lower case on Windows (case-insensitive FS). */
function keyOf(file: string): string {
  const rel = path.relative(PRODUCTION_ROOT, path.resolve(file)).split(path.sep).join("/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

/**
 * The file's text, exactly as `fs.readFileSync(file, "utf8")` returns it now. Served from the
 * cache only when size + mtime + ctime match the cached entry AND the entry is not racy (R-2582: a
 * racy entry is re-read and its bytes compared). A missing file throws, as a read does.
 */
export function readSource(file: string): string {
  const now = Date.now();
  const st = fs.statSync(file);
  const map = load();
  const key = keyOf(file);
  const e = map.get(key);
  const sameStat = !!e && e.s === st.size && e.m === st.mtimeMs && e.c === st.ctimeMs;
  if (e && sameStat && !isRacy(e)) {
    if (e.text === undefined) e.text = e.buf!.toString("utf8");
    return e.text;
  }
  const raw = fs.readFileSync(file);
  if (e && sameStat && e.buf && raw.equals(e.buf)) {
    // Racy but unchanged: trusted in memory once a re-read finds the file aged. Not added to `fresh`:
    // persisting a promotion would rewrite the whole ~50 MB cache file to save one small re-read.
    const next: Entry = { ...e, r: now };
    map.set(key, next);
    if (next.text === undefined) next.text = raw.toString("utf8");
    return next.text;
  }
  const text = raw.toString("utf8");
  map.set(key, { s: st.size, m: st.mtimeMs, c: st.ctimeMs, r: now, buf: raw, text });
  fresh.add(key);
  return text;
}

/**
 * Add what this process read from disk to the cache file. Called by afterAll; safe to call again.
 * One writer at a time (a `.lock` file; a test file that finds it taken skips — the writer holds
 * nearly the same files). Inside the lock the file is re-read and merged, nothing is written when it
 * already holds every fresh entry, and entries whose file is gone (deleted, renamed) are dropped —
 * so a dozen test files finishing a cold run (or a run after a rebase) write once, not ~50 MB each.
 */
export function flushSourceCache(): void {
  if (!entries || !fresh.size) return;
  const mine = fresh;
  fresh = new Set();
  const lock = `${cacheFile}.lock`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    if (!takeLock(lock)) return;
  } catch { return; }
  try {
    const merged = readCacheFile();
    let added = 0;
    for (const k of mine) {
      const e = entries.get(k)!;
      const d = merged.get(k);
      if (d && sameAs(d, e)) continue;
      merged.set(k, e);
      added++;
    }
    if (!added) return;
    pruneOldCaches();
    for (const k of [...merged.keys()]) if (!mine.has(k) && !fs.existsSync(path.resolve(PRODUCTION_ROOT, k))) merged.delete(k);
    const rows: IndexRow[] = [];
    const parts: Buffer[] = [];
    let off = 0;
    for (const [k, e] of merged) {
      const b = e.buf ?? Buffer.from(e.text ?? "", "utf8");
      rows.push([k, e.s, e.m, e.c, e.r, off, b.length]);
      parts.push(b);
      off += b.length;
    }
    const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(JSON.stringify({ magic: MAGIC, rows }) + "\n", "utf8"), ...parts]));
    try { fs.renameSync(tmp, cacheFile); } catch { fs.rmSync(tmp, { force: true }); }
  } catch { /* cache is only for speed */ }
  finally { fs.rmSync(lock, { force: true }); }
}

/** The disk entry `d` already says what `e` says: same stat, and — when either is racy (R-2582: a
    same-tick rewrite keeps the stat) — same bytes too. A trusted `e` never loses to a racy `d`. */
function sameAs(d: Entry, e: Entry): boolean {
  if (d.s !== e.s || d.m !== e.m || d.c !== e.c) return false;
  if (!isRacy(d) && !isRacy(e)) return true;
  if (isRacy(d) && !isRacy(e)) return false;
  const eb = e.buf ?? Buffer.from(e.text ?? "", "utf8");
  return !!d.buf && d.buf.equals(eb);
}

/** Create the lock file; a lock older than 2 minutes is a crashed writer's and is taken over. */
function takeLock(lock: string): boolean {
  for (let i = 0; i < 2; i++) {
    try { fs.closeSync(fs.openSync(lock, "wx")); return true; } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < 120_000) return false;
        fs.rmSync(lock, { force: true });
      } catch { return false; }
    }
  }
  return false;
}

/** Caches of worktrees that were removed: delete any cache file not touched for 3 days. */
function pruneOldCaches(): void {
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    /* R-2582: this checkout's old-format (-v2) cache can never be read again — drop it at once. */
    const oldFormat = path.basename(cacheFile).replace(/-v3\.bin$/, "-v2.bin");
    for (const n of fs.readdirSync(path.dirname(cacheFile))) {
      const p = path.join(path.dirname(cacheFile), n);
      if (p !== cacheFile && !p.endsWith(".lock") && (n === oldFormat || fs.statSync(p).mtimeMs < cutoff)) fs.rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

/* Registered when a test file imports this module (its collection phase), so it runs once after
   that file's tests. Outside a vitest collection (a plain script) the caller flushes. */
try { afterAll(() => flushSourceCache()); } catch { /* not inside a test file */ }

/** Test hook: forget the in-memory copy (the next read loads the cache file again); `file` points
    the cache somewhere else (a temp folder) so a test never touches the shared one. */
export function resetSourceCacheForTest(file?: string): void {
  entries = null;
  fresh = new Set();
  if (file) cacheFile = file;
}
