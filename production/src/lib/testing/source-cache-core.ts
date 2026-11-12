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
 * R-2630 (9 Nov 2026), buckets: the one cache file had grown to ~89 MB (36 MB of it Prisma's generated
 * client) and EVERY guard file that read even one migration loaded all of it — ~70 forks × 89 MB, with
 * 22 forks at once on a laptop already running other workers' tsc. Now the entries live in four files
 * by where the source is (BUCKETS: src/, Prisma's generated client, supabase/, everything else), and a
 * bucket file is loaded only when a key of that bucket is first asked for. A migration scan loads
 * ~12 MB, a src/ scan ~20 MB, the generated client only by a scan that really follows imports into it.
 * Same stat/racy checks per entry; each bucket file is written, locked and pruned like the old one.
 *
 * Test-only: imported by *.test.ts files (and test-only scanners), never by app code.
 * R-2649 (10 Nov 2026): this is the core (no vitest import); `./source-cache` re-exports it and adds the
 * afterAll flush. Tests import `./source-cache`; only the guard-run globalSetup imports the core.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PRODUCTION_ROOT, PRISMA_GENERATED } from "./prisma-generated";

/** s/m/c = size, mtimeMs, ctimeMs at read time; r = Date.now() just before that read (R-2582);
    text decoded lazily from `buf`. */
type Entry = { s: number; m: number; c: number; r: number; buf?: Buffer; text?: string };
type IndexRow = [key: string, s: number, m: number, c: number, r: number, offset: number, length: number];

const MAGIC = "reselleros-source-cache v4";
/** R-2582: an entry read less than this long after the file's mtime may hide a same-tick rewrite. */
export const RACY_MS = 2000;
const isRacy = (e: Entry): boolean => e.r - Math.max(e.m, e.c) < RACY_MS;
export const SOURCE_CACHE_DIR = path.join(os.tmpdir(), "reselleros-source-cache");
/** One cache per checkout (each worktree has its own production/). */
export const SOURCE_CACHE_FILE = path.join(
  SOURCE_CACHE_DIR,
  `${crypto.createHash("sha1").update(PRODUCTION_ROOT.toLowerCase()).digest("hex").slice(0, 12)}-v4.bin`,
);

/** R-2630: a key's bucket — which cache file holds it ("" = the base file, for everything not below). */
export const BUCKETS = ["", "src", "gen", "sql"] as const;
export type Bucket = (typeof BUCKETS)[number];
/** Prisma's generated client as a key prefix — from PRISMA_GENERATED (pinned to the schema's output). */
const GEN_PREFIX = `${keyOf(PRISMA_GENERATED)}/`;
export function bucketOf(key: string): Bucket {
  if (key.startsWith(GEN_PREFIX)) return "gen";
  if (key.startsWith("src/")) return "src";
  if (key.startsWith("supabase/")) return "sql";
  return "";
}

let cacheFile = SOURCE_CACHE_FILE;
/** The file a bucket lives in: the base file itself for "", `<base>.<bucket>` for the others. */
export function bucketFile(b: Bucket, base: string = cacheFile): string {
  return b ? `${base}.${b}` : base;
}
/** Loaded buckets only — a bucket's file is read the first time one of its keys is asked for. */
let entries = new Map<Bucket, Map<string, Entry>>();
/** Keys this process read from disk (new or changed) — the only ones a flush has to add. */
let fresh = new Set<string>();

/** A cache file as entries; empty when missing, unreadable, another format or cut short. */
function readCacheFile(file: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const all = fs.readFileSync(file);
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

function load(b: Bucket): Map<string, Entry> {
  let map = entries.get(b);
  if (!map) { map = readCacheFile(bucketFile(b)); entries.set(b, map); }
  return map;
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
  const key = keyOf(file);
  const map = load(bucketOf(key));
  const e = map.get(key);
  if (e && servable(e, st)) {
    if (e.text === undefined) e.text = e.buf!.toString("utf8");
    return e.text;
  }
  const raw = fs.readFileSync(file);
  const next = settle(map, key, e, st, raw, now);
  if (next.text === undefined) next.text = raw.toString("utf8");
  return next.text;
}

const sameStat = (e: Entry, st: fs.Stats): boolean => e.s === st.size && e.m === st.mtimeMs && e.c === st.ctimeMs;
/** The entry may be served on its stat alone: same size + mtime + ctime and not racy (R-2582). */
const servable = (e: Entry, st: fs.Stats): boolean => sameStat(e, st) && !isRacy(e);

/**
 * After a disk read of `raw` (clock `now` taken before the stat `st`): a racy entry whose bytes are
 * unchanged is trusted in memory from now on — not added to `fresh`: persisting a promotion would
 * rewrite a whole bucket file (up to ~36 MB) to save one small re-read. Anything else is stored as a
 * new entry for the next flush. One rule for readSource and primeSources (R-2649).
 */
function settle(map: Map<string, Entry>, key: string, e: Entry | undefined, st: fs.Stats, raw: Buffer, now: number): Entry {
  if (e && sameStat(e, st) && e.buf && raw.equals(e.buf)) {
    const next: Entry = { ...e, r: now };
    map.set(key, next);
    return next;
  }
  const next: Entry = { s: st.size, m: st.mtimeMs, c: st.ctimeMs, r: now, buf: raw };
  map.set(key, next);
  fresh.add(key);
  return next;
}

/**
 * R-2649: fill the cache for many files at once (the guard run's warm-up, warm-source-cache.ts) —
 * `concurrency` stats/reads in flight instead of one. Same order and rules as readSource (servable /
 * settle): clock, then stat, then read, so a file edited between them has a newer mtime than its entry
 * and is read again later. Stores entries only — the text is still served by readSource, which checks
 * the stat on every call. Returns how many files were read from disk; unreadable ones are skipped.
 */
export async function primeSources(files: readonly string[], concurrency = 32): Promise<number> {
  let next = 0;
  let read = 0;
  async function one(file: string): Promise<void> {
    const now = Date.now();
    const st = await fs.promises.stat(file);
    const key = keyOf(file);
    const map = load(bucketOf(key));
    const e = map.get(key);
    if (e && servable(e, st)) return;
    const raw = await fs.promises.readFile(file);
    read++;
    settle(map, key, e, st, raw, now);
  }
  async function lane(): Promise<void> {
    while (next < files.length) {
      const f = files[next++];
      try { await one(f); } catch { /* gone or unreadable — the scan that needs it will say so */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, lane));
  return read;
}

/**
 * Add what this process read from disk to the cache file. Called by afterAll; safe to call again.
 * One writer at a time (a `.lock` file; a test file that finds it taken skips — the writer holds
 * nearly the same files). Inside the lock the file is re-read and merged, nothing is written when it
 * already holds every fresh entry, and entries whose file is gone (deleted, renamed) are dropped —
 * so a dozen test files finishing a cold run (or a run after a rebase) write once, not ~50 MB each.
 */
export function flushSourceCache(opts: { waitMs?: number } = {}): void {
  if (!fresh.size) return;
  const mine = fresh;
  fresh = new Set();
  /* R-2630: each bucket that got fresh entries is merged into its own file, under its own lock. */
  const byBucket = new Map<Bucket, Set<string>>();
  for (const k of mine) {
    const b = bucketOf(k);
    if (!byBucket.has(b)) byBucket.set(b, new Set());
    byBucket.get(b)!.add(k);
  }
  for (const [b, keys] of byBucket) flushBucket(b, keys, opts.waitMs ?? 0);
}

function flushBucket(b: Bucket, mine: Set<string>, waitMs: number): void {
  const map = entries.get(b);
  if (!map) return;
  const file = bucketFile(b);
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!takeLock(lock, waitMs)) return;
  } catch { return; }
  try {
    const merged = readCacheFile(file);
    let added = 0;
    for (const k of mine) {
      const e = map.get(k)!;
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
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(JSON.stringify({ magic: MAGIC, rows }) + "\n", "utf8"), ...parts]));
    try { fs.renameSync(tmp, file); } catch { fs.rmSync(tmp, { force: true }); }
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

/** Create the lock file; a lock older than 2 minutes is a crashed writer's and is taken over.
    R-2649: with `waitMs` (the warm-up, whose whole point is to write) a held lock is waited for, then
    taken over — a fork killed mid-flush by the push's run timeout leaves a fresh lock behind, and
    skipping would leave every fork of the next run cold. Two writers only cost speed: each writes a
    temp file and renames it, so a reader never sees half a file. */
function takeLock(lock: string, waitMs = 0): boolean {
  const deadline = Date.now() + waitMs;
  for (let vanished = 0; ;) {
    try { fs.closeSync(fs.openSync(lock, "wx")); return true; } catch { /* held */ }
    let age: number;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {
      if (++vanished > 3) return false; // released between our open and stat — just try again
      continue;
    }
    if (age >= 120_000 || (waitMs > 0 && Date.now() >= deadline)) {
      fs.rmSync(lock, { force: true });
      try { fs.closeSync(fs.openSync(lock, "wx")); return true; } catch { return false; }
    }
    if (waitMs <= 0) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // sync sleep 50 ms
  }
}

let pruned = false;
/** Caches of worktrees that were removed: delete any cache file not touched for 3 days. */
function pruneOldCaches(): void {
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    /* R-2582 / R-2630: this checkout's old-format (-v2, -v3) caches can never be read again — drop them
       at once. Its own bucket files (<base>, <base>.src, …) are kept. */
    if (pruned) return; // once per process, not once per bucket flushed
    pruned = true;
    const own = path.basename(cacheFile);
    const keep = new Set(BUCKETS.map((b) => bucketFile(b, own)));
    const oldFormat = /-v4\.bin$/.test(own) ? [own.replace(/-v4\.bin$/, "-v2.bin"), own.replace(/-v4\.bin$/, "-v3.bin")] : [];
    for (const n of fs.readdirSync(path.dirname(cacheFile))) {
      const p = path.join(path.dirname(cacheFile), n);
      if (keep.has(n) || n.endsWith(".lock")) continue; // a crashed writer's .tmp still goes after 3 days
      if (oldFormat.includes(n) || fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

/* The afterAll flush is registered by ./source-cache.ts (the module tests import). This core imports
   nothing from vitest, so a vitest globalSetup (warm-source-cache.ts, R-2649) can load it — vitest
   refuses to be imported there. */

/** R-2649: free the in-memory copy (the warm-up, after its flush — tens of MB the long-lived vitest
    parent would otherwise hold for the whole guard run). Unflushed entries are dropped too. */
export function dropSourceCacheMemory(): void {
  entries = new Map();
  fresh = new Set();
}

/** Test hook: forget the in-memory copy (the next read loads the cache file again); `file` points
    the cache somewhere else (a temp folder) so a test never touches the shared one. */
export function resetSourceCacheForTest(file?: string): void {
  dropSourceCacheMemory();
  if (file) cacheFile = file;
}
