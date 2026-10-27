import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { restoreBuildInfo, saveBuildInfo, dropBuildInfo, cacheFile, pruneCache, parseTscFlags, BUILD_INFO, TSC_FULL_STEP } from "../../scripts/ops/worker-tsc-cache.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { tscStepsFor, TSC_STEPS } from "../../scripts/ops/worker-lock.mjs";

/* R-1960 (26 Oct 2026): the worker gate's tsc reuses a shared build info between worktrees.
   The risk Pardeep named: a type error slips past the gate because the cache "remembers" green.
   These tests run the REAL tsc on two sibling "worktrees" that share one cache folder, exactly as
   worker-lock does (restore → tsc → save on green), and prove the gate still goes red for
   (1) an error in the changed file and (2) an error that shows up only in an UNCHANGED importer. */

const TSC = path.resolve("node_modules/typescript/lib/tsc.js");
let tmp: string, cache: string;

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, incremental: true, target: "ES2022", lib: ["es2022"], types: [], module: "esnext", moduleResolution: "bundler" },
  include: ["*.ts"],
});
const A_OK = "export function price(amount: number): number { return amount * 2; }\n";
const B = 'import { price } from "./a";\nexport const total: number = price(5);\n';
const C = 'import { total } from "./b";\nexport const shown: number = total + 1;\n';

function worktree(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
  fs.writeFileSync(path.join(dir, "a.ts"), A_OK);
  fs.writeFileSync(path.join(dir, "b.ts"), B);
  fs.writeFileSync(path.join(dir, "c.ts"), C);
  return dir;
}

/** worker-lock's default (incremental) gate on a worktree: restore, tsc, save on green. */
function gate(dir: string) {
  const restored = restoreBuildInfo(dir, { dir: cache });
  const r = spawnSync(process.execPath, [TSC, "--noEmit", "-p", "."], { cwd: dir, encoding: "utf8" });
  const green = r.status === 0;
  if (green) saveBuildInfo(dir, { dir: cache });
  return { green, out: `${r.stdout}${r.stderr}`, restored };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r1960-tsc-"));
  cache = path.join(tmp, "cache");
  /* The first worktree fills the shared cache. */
  const first = worktree("wt-first");
  const r = gate(first);
  expect(r.green).toBe(true);
  expect(r.restored.reason).toBe("empty");
  expect(fs.existsSync(cacheFile(first, cache))).toBe(true);
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("R-1960 shared tsc build info", () => {
  it("a NEW worktree starts from the shared cache and stays green when nothing is wrong", () => {
    const wt = worktree("wt-clean");
    const r = gate(wt);
    expect(r.restored.restored).toBe(true);
    expect(r.green).toBe(true);
  });

  it("a deliberate type error in the CHANGED file is still caught (warm cache)", () => {
    const wt = worktree("wt-changed");
    fs.writeFileSync(path.join(wt, "a.ts"), A_OK + 'export const wrong: number = "not a number";\n');
    const r = gate(wt);
    expect(r.restored.restored).toBe(true);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/a\.ts\(2,\d+\): error TS2322/);
  });

  it("an error only in an UNCHANGED importer (b.ts) is caught too", () => {
    const wt = worktree("wt-importer");
    /* Only a.ts changes; it compiles on its own. b.ts and c.ts are byte-identical to the cached run. */
    fs.writeFileSync(path.join(wt, "a.ts"), "export function price(amount: number): string { return String(amount * 2); }\n");
    const r = gate(wt);
    expect(r.restored.restored).toBe(true);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/b\.ts\(2,\d+\): error TS2322/);
    expect(r.out).not.toMatch(/a\.ts\(/);
  });

  it("an importer's error two hops away (c.ts) is caught when the middle file's type changes", () => {
    const wt = worktree("wt-chain");
    fs.writeFileSync(path.join(wt, "b.ts"), 'import { price } from "./a";\nexport const total: string = String(price(5));\n');
    const r = gate(wt);
    expect(r.green).toBe(false);
    expect(r.out).toMatch(/c\.ts\(2,\d+\): error TS2322/);
  });

  it("a red run never replaces the shared cache", () => {
    const before = fs.readFileSync(cacheFile(path.join(tmp, "wt-first"), cache), "utf8");
    const wt = worktree("wt-red");
    fs.writeFileSync(path.join(wt, "c.ts"), 'export const x: number = "y";\n');
    expect(gate(wt).green).toBe(false);
    expect(fs.readFileSync(cacheFile(wt, cache), "utf8")).toBe(before);
  });

  it("the worktree's own build info wins over the shared one; drop removes it", () => {
    const wt = worktree("wt-own");
    fs.writeFileSync(path.join(wt, BUILD_INFO), "{}");
    expect(restoreBuildInfo(wt, { dir: cache })).toEqual({ restored: false, reason: "own" });
    dropBuildInfo(wt);
    expect(fs.existsSync(path.join(wt, BUILD_INFO))).toBe(false);
  });
});

/* Measured 26 Oct: a build info from a base with one route fewer gave a 704 s run (cold is 525 s) —
   .next/types/routes.d.ts is a GLOBAL file, so any change re-checks everything. The key therefore
   includes the generated route types: a different route set never restores, it runs cold and saves
   under its own key. */
describe("R-1960 cache key follows the generated route types", () => {
  function withRoutes(name: string, routes: string) {
    const wt = worktree(name);
    fs.mkdirSync(path.join(wt, ".next", "types"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".next", "types", "routes.d.ts"), routes);
    return wt;
  }

  it("same route types → same key; one route more → a different key, so no restore", () => {
    const a = withRoutes("wt-routes-a", 'type R = "/a";\n');
    const b = withRoutes("wt-routes-b", 'type R = "/a";\n');
    const c = withRoutes("wt-routes-c", 'type R = "/a" | "/b";\n');
    expect(cacheFile(a, cache)).toBe(cacheFile(b, cache));
    expect(cacheFile(c, cache)).not.toBe(cacheFile(a, cache));
    saveBuildInfo(a, { dir: cache }); // nothing written yet in a → no-op
    fs.writeFileSync(path.join(a, BUILD_INFO), "{}");
    expect(saveBuildInfo(a, { dir: cache }).saved).toBe(true);
    expect(restoreBuildInfo(b, { dir: cache }).restored).toBe(true);
    expect(restoreBuildInfo(c, { dir: cache })).toEqual({ restored: false, reason: "empty" });
  });

  it("keeps only the newest CACHE_KEEP shared files", () => {
    const dir = path.join(tmp, "prune");
    fs.mkdirSync(dir);
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `tsc-00000000000${i}.tsbuildinfo`);
      fs.writeFileSync(f, "{}");
      fs.utimesSync(f, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    fs.writeFileSync(path.join(dir, "other.txt"), "x");
    pruneCache(dir, 2);
    expect(fs.readdirSync(dir).sort()).toEqual(["other.txt", "tsc-000000000003.tsbuildinfo", "tsc-000000000004.tsbuildinfo"]);
  });

  it("worker-lock restores only after `next typegen` (the key needs the fresh route types)", () => {
    const src = fs.readFileSync(path.resolve("scripts/ops/worker-lock.mjs"), "utf8");
    const body = src.slice(src.indexOf("function tscWithTurn"), src.indexOf("function tscWithTurn") + 2000);
    expect(body).toMatch(/if \(!full && step === TSC_STEPS\[TSC_STEPS\.length - 1\]\) \{\s*const r = restoreBuildInfo\(root\)/);
    expect(body.indexOf("saveBuildInfo(root)")).toBeGreaterThan(body.indexOf("sh(step, tscEnv())"));
  });
});

describe("R-1960 --full-tsc keeps the old cold check", () => {
  it("parses --full-tsc / --full", () => {
    expect(parseTscFlags(["--full-tsc"]).full).toBe(true);
    expect(parseTscFlags(["--full"]).full).toBe(true);
    expect(parseTscFlags(["--card", "x.json"]).full).toBe(false);
  });

  it("full mode = typegen + tsc with --incremental false; default = the usual steps", () => {
    expect(tscStepsFor({ full: true })).toEqual([TSC_STEPS[0], TSC_FULL_STEP]);
    expect(TSC_FULL_STEP).toBe("npx tsc --noEmit -p . --incremental false");
    expect(tscStepsFor()).toEqual(TSC_STEPS);
  });
});
