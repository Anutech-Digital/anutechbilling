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
 * updates the entry. So a scan always sees what is on disk NOW — an edit, checkout or rebase changes
 * mtime/ctime and that file is read again (ctime also catches a copy that kept the old mtime).
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

/** s/m/c = size, mtimeMs, ctimeMs at read time; text decoded lazily from `buf`. */
type Entry = { s: number; m: number; c: number; buf?: Buffer; text?: string };
type IndexRow = [key: string, s: number, m: number, c: number, offset: number, length: number];

const MAGIC = "reselleros-source-cache v2";
export const SOURCE_CACHE_DIR = path.join(os.tmpdir(), "reselleros-source-cache");
/** One cache per checkout (each worktree has its own production/). */
export const SOURCE_CACHE_FILE = path.join(
  SOURCE_CACHE_DIR,
  `${crypto.createHash("sha1").update(PRODUCTION_ROOT.toLowerCase()).digest("hex").slice(0, 12)}-v2.bin`,
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
    for (const [k, s, m, c, off, len] of head.rows) {
      if (base + off + len > all.length) return new Map(); // torn → trust nothing
      out.set(k, { s, m, c, buf: all.subarray(base + off, base + off + len) });
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
 * cache only when size + mtime + ctime match the cached entry. A missing file throws, as a read does.
 */
export function readSource(file: string): string {
  const st = fs.statSync(file);
  const map = load();
  const key = keyOf(file);
  const e = map.get(key);
  if (e && e.s === st.size && e.m === st.mtimeMs && e.c === st.ctimeMs) {
    if (e.text === undefined) e.text = e.buf!.toString("utf8");
    return e.text;
  }
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8");
  map.set(key, { s: st.size, m: st.mtimeMs, c: st.ctimeMs, buf: raw, text });
  fresh.add(key);
  return text;
}

/**
 * Add what this process read from disk to the cache file. Called by afterAll; safe to call again.
 * The file is re-read first and merged, and nothing is written when it already holds every fresh
 * entry — so when a dozen test files finish a cold run together, the first writes and the rest
 * (which read the same files) skip, instead of each writing ~50 MB.
 */
export function flushSourceCache(): void {
  if (!entries || !fresh.size) return;
  const mine = fresh;
  fresh = new Set();
  try {
    const merged = readCacheFile();
    let added = 0;
    for (const k of mine) {
      const e = entries.get(k)!;
      const d = merged.get(k);
      if (d && d.s === e.s && d.m === e.m && d.c === e.c) continue;
      merged.set(k, e);
      added++;
    }
    if (!added) return;
    pruneOldCaches();
    const rows: IndexRow[] = [];
    const parts: Buffer[] = [];
    let off = 0;
    for (const [k, e] of merged) {
      const b = e.buf ?? Buffer.from(e.text ?? "", "utf8");
      rows.push([k, e.s, e.m, e.c, off, b.length]);
      parts.push(b);
      off += b.length;
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from(JSON.stringify({ magic: MAGIC, rows }) + "\n", "utf8"), ...parts]));
    try { fs.renameSync(tmp, cacheFile); } catch { fs.rmSync(tmp, { force: true }); }
  } catch { /* cache is only for speed */ }
}

/** Caches of worktrees that were removed: delete any cache file not touched for 3 days. */
function pruneOldCaches(): void {
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const n of fs.readdirSync(path.dirname(cacheFile))) {
      const p = path.join(path.dirname(cacheFile), n);
      if (p !== cacheFile && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
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
