import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSource, flushSourceCache, resetSourceCacheForTest } from "./source-cache";

/* R-2564: the shared read cache of the whole-src scans must never serve old text — a guard that
   reads yesterday's file passes on today's bug. Every test points the cache at a temp folder. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2564-source-cache-"));
const cacheFile = path.join(dir, "cache.json");
/* Hooks run in reverse: this runs BEFORE the module's own afterAll flush — clear the fresh set so that
   flush writes nothing (it would recreate the temp folder just removed). */
afterAll(() => { resetSourceCacheForTest(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { fs.rmSync(cacheFile, { force: true }); resetSourceCacheForTest(cacheFile); vi.restoreAllMocks(); });

describe("readSource (shared, always-fresh read cache for scan tests)", () => {
  it("returns what readFileSync returns", () => {
    const f = path.join(dir, "a.ts");
    fs.writeFileSync(f, "export const a = 1; // ₹ ü\r\n");
    expect(readSource(f)).toBe(fs.readFileSync(f, "utf8"));
  });

  it("an edit is seen at once — even one that keeps the size (must go red on a stale read)", () => {
    const f = path.join(dir, "b.ts");
    fs.writeFileSync(f, "const x = 'safe';");
    expect(readSource(f)).toBe("const x = 'safe';");
    fs.writeFileSync(f, "const x = 'BAD!';"); // same length
    expect(readSource(f)).toBe("const x = 'BAD!';");
  });

  it("an edit is seen after the cache went to disk and came back (a later test file / run)", () => {
    const f = path.join(dir, "c.ts");
    fs.writeFileSync(f, "one");
    readSource(f);
    flushSourceCache();
    expect(fs.existsSync(cacheFile)).toBe(true);
    fs.writeFileSync(f, "two");
    resetSourceCacheForTest(cacheFile);
    expect(readSource(f)).toBe("two");
  });

  it("R-2582: a same-size rewrite whose size, mtime AND ctime all stay the same is still seen", () => {
    // Cloud Build (8 Nov, build 56911293): a rewrite inside one timestamp tick kept every stat field,
    // so the cache served the old text. Simulate exactly that: the rewritten file stats as before.
    const f = path.join(dir, "m.ts");
    fs.writeFileSync(f, "const y = 'safe';");
    const before = fs.statSync(f);
    expect(readSource(f)).toBe("const y = 'safe';");
    fs.writeFileSync(f, "const y = 'BAD!';"); // same length
    fs.utimesSync(f, before.atime, before.mtime);
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) =>
      p === f ? before : realStat(p, o)) as typeof fs.statSync);
    expect(readSource(f)).toBe("const y = 'BAD!';");
    // …and after the cache went to disk and came back
    flushSourceCache();
    resetSourceCacheForTest(cacheFile);
    expect(readSource(f)).toBe("const y = 'BAD!';");
  });

  it("R-2582: a racy entry is re-checked, and trusted again once the file has aged", () => {
    const f = path.join(dir, "n.ts");
    fs.writeFileSync(f, "young");
    const t = Date.now();
    readSource(f); // cached right after the write → racy
    const reads = vi.spyOn(fs, "readFileSync");
    expect(readSource(f)).toBe("young");
    expect(reads.mock.calls.filter(([p]) => p === f).length).toBe(1); // re-read, not trusted
    vi.spyOn(Date, "now").mockReturnValue(t + 10_000); // the file is now old
    expect(readSource(f)).toBe("young"); // one more check stamps it trusted…
    expect(readSource(f)).toBe("young"); // …so this one is stat-only
    expect(reads.mock.calls.filter(([p]) => p === f).length).toBe(2);
  });

  it("an unchanged file is served from the cache file, not read again", () => {
    const f = path.join(dir, "d.ts");
    fs.writeFileSync(f, "unchanged");
    // An old file (written well before it was cached) is trusted on stat alone — the fast path.
    fs.utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    readSource(f);
    flushSourceCache();
    resetSourceCacheForTest(cacheFile);
    const spy = vi.spyOn(fs, "readFileSync");
    expect(readSource(f)).toBe("unchanged");
    expect(spy.mock.calls.filter(([p]) => p === f)).toEqual([]);
  });

  it("a missing file still throws (a scan never silently skips a file it listed)", () => {
    expect(() => readSource(path.join(dir, "gone.ts"))).toThrow();
  });

  it("a flush merges with what another test file wrote meanwhile, and skips when nothing is new", () => {
    const f = path.join(dir, "h.ts"), g = path.join(dir, "i.ts");
    fs.writeFileSync(f, "from f");
    fs.writeFileSync(g, "from g");
    for (const p of [f, g]) fs.utimesSync(p, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    readSource(f);
    flushSourceCache();
    const theirs = fs.readFileSync(cacheFile); // "another test file" cached f
    // this process started cold, read f — then the other one's cache landed first
    fs.rmSync(cacheFile);
    resetSourceCacheForTest(cacheFile);
    readSource(f);
    fs.writeFileSync(cacheFile, theirs);
    fs.utimesSync(cacheFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
    flushSourceCache();
    expect(fs.statSync(cacheFile).mtime.getFullYear()).toBe(2000); // nothing new → no 50 MB write
    // now it also read g: the flush keeps their f and adds g
    readSource(g);
    flushSourceCache();
    resetSourceCacheForTest(cacheFile);
    const spy = vi.spyOn(fs, "readFileSync");
    expect(readSource(f)).toBe("from f");
    expect(readSource(g)).toBe("from g");
    expect(spy.mock.calls.filter(([p]) => p === f || p === g)).toEqual([]);
  });

  it("one writer at a time: a fresh lock skips the write, a crashed writer's old lock is taken over", () => {
    const f = path.join(dir, "j.ts");
    fs.writeFileSync(f, "locked");
    const lock = `${cacheFile}.lock`;
    fs.writeFileSync(lock, "");
    readSource(f);
    flushSourceCache();
    expect(fs.existsSync(cacheFile)).toBe(false);
    fs.utimesSync(lock, new Date(2000, 0, 1), new Date(2000, 0, 1));
    resetSourceCacheForTest(cacheFile);
    readSource(f);
    flushSourceCache();
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("drops entries whose file is gone", () => {
    const f = path.join(dir, "k.ts"), g = path.join(dir, "l.ts");
    fs.writeFileSync(f, "kept");
    fs.writeFileSync(g, "deleted soon");
    readSource(f);
    readSource(g);
    flushSourceCache();
    const before = fs.statSync(cacheFile).size;
    fs.rmSync(g);
    fs.writeFileSync(f, "kept, edited");
    resetSourceCacheForTest(cacheFile);
    readSource(f);
    flushSourceCache();
    expect(fs.statSync(cacheFile).size).toBeLessThan(before);
    expect(fs.readFileSync(cacheFile).includes(Buffer.from("deleted soon"))).toBe(false);
  });

  it("a cut-short cache file (torn write) is ignored, not trusted", () => {
    const f = path.join(dir, "g.ts");
    fs.writeFileSync(f, "x".repeat(5000));
    readSource(f);
    flushSourceCache();
    const whole = fs.readFileSync(cacheFile);
    fs.writeFileSync(cacheFile, whole.subarray(0, whole.length - 100));
    resetSourceCacheForTest(cacheFile);
    const spy = vi.spyOn(fs, "readFileSync");
    expect(readSource(f)).toBe("x".repeat(5000));
    expect(spy.mock.calls.some(([p]) => p === f)).toBe(true); // read from disk again
  });

  it("a broken cache file is ignored, not trusted", () => {
    fs.writeFileSync(cacheFile, "{ not json");
    const f = path.join(dir, "e.ts");
    fs.writeFileSync(f, "fresh");
    expect(readSource(f)).toBe("fresh");
  });
});
