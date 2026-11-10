import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSourceFiles } from "./walk-source";
import { warmSourceCache } from "./warm-source-cache";
import { BUCKETS, bucketFile, readSource, resetSourceCacheForTest } from "./source-cache";
import { PRISMA_GENERATED, isPrismaGenerated } from "./prisma-generated";

/* R-2649: the shared walk must list EXACTLY what the old hand walkers listed (statSync per entry),
   or a scan silently checks fewer files. Small fixture trees — a whole-src walk is too slow for CI's 5 s. */
function statWalk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (!isPrismaGenerated(p)) statWalk(p, out); }
    else out.push(p);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2649-walk-"));
afterAll(() => { resetSourceCacheForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

describe("listSourceFiles (R-2649 shared src walk)", () => {
  it("lists the same files as the old statSync walk — nested dirs, a linked dir, dotted names", () => {
    const d = path.join(tmp, "w");
    tree(d, { "a.ts": "a", "sub/b.test.tsx": "b", "sub/deep/c.ts": "c", ".next/d.ts": "d", "x.md": "x", "linked/e.ts": "e" });
    fs.symlinkSync(path.join(d, "linked"), path.join(d, "sub", "via-link"), "junction");
    const mine = listSourceFiles(d).sort();
    expect(mine).toEqual(statWalk(d).sort());
    expect(mine).toContain(path.join(d, "sub", "via-link", "e.ts"));
    expect(listSourceFiles(d, (n) => /\.ts$/.test(n)).sort()).toEqual(statWalk(d).filter((f) => /\.ts$/.test(f)).sort());
  });

  it("skips exactly the generated Prisma client folder; a later call sees a file written since", () => {
    expect(isPrismaGenerated(PRISMA_GENERATED)).toBe(true);
    const d = path.join(tmp, "w2");
    tree(d, { "a.ts": "a" });
    expect(listSourceFiles(d)).toEqual([path.join(d, "a.ts")]);
    tree(d, { "late.ts": "late" }); // no memo: every call is a fresh walk
    expect(listSourceFiles(d).sort()).toEqual([path.join(d, "a.ts"), path.join(d, "late.ts")]);
    expect(listSourceFiles(path.join("src", "lib", "testing"))).toContain(path.join("src", "lib", "testing", "walk-source.ts")); // relative in, relative out
  });
});

describe("warmSourceCache (R-2649 guard-run globalSetup)", () => {
  function prodTree(name: string): string {
    const root = path.join(tmp, name);
    tree(root, {
      "src/a.ts": "a", "src/x/b.tsx": "b", "src/notes.md": "skip-md",
      "supabase/migrations/1.sql": "select 1;", "supabase/cloudsql/shim.sql": "select 2;", "supabase/tests/t.sql": "skip-tests",
    });
    return root;
  }
  const bucketsText = (cache: string) =>
    BUCKETS.map((b) => bucketFile(b, cache)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");

  it("reads src/*.ts(x), supabase/migrations + cloudsql *.sql into the cache, nothing else; warm = no reads", async () => {
    const root = prodTree("prod");
    const old = new Date(Date.now() - 3600_000); // R-2582: not racy — checked out an hour ago
    for (const f of ["src/a.ts", "src/x/b.tsx", "supabase/migrations/1.sql", "supabase/cloudsql/shim.sql"]) fs.utimesSync(path.join(root, f), old, old);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    const cache = path.join(tmp, "cache.bin");
    resetSourceCacheForTest(cache);
    expect(await warmSourceCache(root)).toBe(4);
    expect(await warmSourceCache(root)).toBe(0); // warm already (memory dropped, cache files reloaded): stats only
    clock.mockRestore();
    const all = bucketsText(cache);
    expect(all).toContain("select 1;");
    expect(all).toContain("select 2;");
    expect(all).not.toContain("skip-md");
    expect(all).not.toContain("skip-tests");
  });

  it("never makes a scan read old text: an edit after the warm-up (same size) is seen", async () => {
    const root = prodTree("prod2");
    const f = path.join(root, "src", "a.ts");
    fs.writeFileSync(f, "const x = 'safe';");
    resetSourceCacheForTest(path.join(tmp, "cache3.bin"));
    await warmSourceCache(root);
    fs.writeFileSync(f, "const x = 'BAD!';"); // same length, maybe the same timestamp tick (racy rule)
    resetSourceCacheForTest();
    expect(readSource(f)).toBe("const x = 'BAD!';");
  });

  it("a fresh lock left by a killed writer does not stop the warm-up from writing", async () => {
    const root = prodTree("prod3");
    const cache = path.join(tmp, "cache4.bin");
    resetSourceCacheForTest(cache);
    fs.writeFileSync(`${cache}.lock`, ""); // a fork killed mid-flush (temp-folder keys land in the base bucket)
    await warmSourceCache(root, 100); // waits 100 ms here (10 s in the guard run), then takes the lock over
    expect(bucketsText(cache)).toContain("select 1;");
    expect(fs.existsSync(`${cache}.lock`)).toBe(false);
  });

  it("a missing folder only costs speed, never throws", async () => {
    resetSourceCacheForTest(path.join(tmp, "cache2.bin"));
    expect(await warmSourceCache(path.join(tmp, "nope"))).toBe(0);
  });
});
