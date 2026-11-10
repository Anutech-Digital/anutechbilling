import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSourceFiles, resetSourceWalkForTest } from "./walk-source";
import { warmSourceCache } from "./warm-source-cache";
import { BUCKETS, bucketFile, resetSourceCacheForTest } from "./source-cache";
import { PRISMA_GENERATED, isPrismaGenerated } from "./prisma-generated";

/* R-2649: the shared walk must list EXACTLY what the old hand walkers listed (statSync per entry),
   or a scan silently checks fewer files. */
function statWalk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (!isPrismaGenerated(p)) statWalk(p, out); }
    else out.push(p);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2649-walk-"));
afterAll(() => { resetSourceCacheForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("listSourceFiles (R-2649 shared src walk)", () => {
  it("lists the same src/ files as the old statSync walk, without the generated Prisma client", () => {
    resetSourceWalkForTest();
    const ts = (n: string) => /\.(ts|tsx)$/.test(n);
    const mine = listSourceFiles("src", ts).sort();
    const old = statWalk("src").filter((f) => ts(path.basename(f))).sort();
    expect(mine).toEqual(old);
    expect(mine.length).toBeGreaterThan(500);
    const gen = path.relative(process.cwd(), PRISMA_GENERATED);
    expect(mine.some((f) => f.startsWith(gen + path.sep))).toBe(false);
  });

  it("walks once per dir, returns a fresh array, keeps relative/absolute as given", () => {
    const d = path.join(tmp, "w");
    fs.mkdirSync(path.join(d, "sub", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(d, "a.ts"), "a");
    fs.writeFileSync(path.join(d, "sub", "b.test.tsx"), "b");
    fs.writeFileSync(path.join(d, "sub", "node_modules", "c.ts"), "c");
    const first = listSourceFiles(d).sort();
    expect(first).toEqual([path.join(d, "a.ts"), path.join(d, "sub", "b.test.tsx")]);
    first.push("x");
    fs.writeFileSync(path.join(d, "late.ts"), "late"); // memoised: same process, same list
    expect(listSourceFiles(d).sort()).toEqual([path.join(d, "a.ts"), path.join(d, "sub", "b.test.tsx")]);
    expect(listSourceFiles(d, (n) => !/\.test\./.test(n))).toEqual([path.join(d, "a.ts")]);
    resetSourceWalkForTest();
    expect(listSourceFiles(d)).toContain(path.join(d, "late.ts"));
  });
});

describe("warmSourceCache (R-2649 guard-run globalSetup)", () => {
  it("reads src/*.ts(x) and supabase/*.sql into the cache, nothing else", () => {
    const root = path.join(tmp, "prod");
    fs.mkdirSync(path.join(root, "src", "x"), { recursive: true });
    fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(root, "src", "x", "b.tsx"), "b");
    fs.writeFileSync(path.join(root, "src", "notes.md"), "skip");
    fs.writeFileSync(path.join(root, "supabase", "migrations", "1.sql"), "select 1;");
    const cache = path.join(tmp, "cache.bin");
    resetSourceCacheForTest(cache);
    resetSourceWalkForTest();
    expect(warmSourceCache(root)).toBe(3);
    const written = BUCKETS.map((b) => bucketFile(b, cache)).filter((f) => fs.existsSync(f));
    expect(written.length).toBeGreaterThan(0);
    const all = written.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(all).toContain("select 1;");
    expect(all).not.toContain("skip");
  });

  it("a missing folder only costs speed, never throws", () => {
    resetSourceCacheForTest(path.join(tmp, "cache2.bin"));
    resetSourceWalkForTest();
    expect(warmSourceCache(path.join(tmp, "nope"))).toBe(0);
  });
});
