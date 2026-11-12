import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { restoreBuildInfo, restoreLine, buildInfoDistance, hasherKind, saveBuildInfo, dropBuildInfo, cacheFile, pruneCache, parseTscFlags, nodeModulesTarget, foreignCount, BUILD_INFO, TSC_FULL_STEP } from "../../scripts/ops/worker-tsc-cache.mjs";
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

  it("an unreadable own build info loses to the shared one (R-2634); drop removes it", () => {
    const wt = worktree("wt-own");
    fs.writeFileSync(path.join(wt, BUILD_INFO), "{}");
    const r = restoreBuildInfo(wt, { dir: cache });
    expect(r.restored).toBe(true);
    expect(r.own).toBeNull();
    expect(r.shared).toMatchObject({ changed: 0, global: 0 });
    dropBuildInfo(wt);
    expect(fs.existsSync(path.join(wt, BUILD_INFO))).toBe(false);
  });
});

/* R-2634 (9 Nov 2026): inside `push` the worktree is rebased onto the newest manager-pardeep, but its
   own build info is from the card's OLD base. R-1960 always kept the own one, so every file merged
   since the base was re-checked (and a route added since then = full re-check). Now restore measures
   both against the files on disk and starts from the closer one. Safety is unchanged: these runs use
   the real tsc and still catch an error in a changed file and in an unchanged importer. */
describe("R-2634 own vs shared build info — the closer one wins", () => {
  const tsc = (wt: string) => spawnSync(process.execPath, [TSC, "--noEmit", "-p", "."], { cwd: wt, encoding: "utf8" });

  /** A worktree that ran tsc green on an OLD base (own build info), then got "rebased": files changed. */
  function staleWorktree(name: string) {
    const wt = worktree(name);
    fs.writeFileSync(path.join(wt, "a.ts"), "export function price(amount: number): number { return amount * 3; }\n");
    fs.writeFileSync(path.join(wt, "c.ts"), C + "export const old = 1;\n");
    expect(tsc(wt).status).toBe(0);
    expect(fs.existsSync(path.join(wt, BUILD_INFO))).toBe(true);
    /* rebase: back to the new base = what the shared cache was saved from */
    fs.writeFileSync(path.join(wt, "a.ts"), A_OK);
    fs.writeFileSync(path.join(wt, "c.ts"), C);
    return wt;
  }

  it("buildInfoDistance counts project files whose text differs from the build info", () => {
    const wt = staleWorktree("wt-dist");
    expect(buildInfoDistance(wt, path.join(wt, BUILD_INFO))).toMatchObject({ changed: 2, global: 0, project: 3 });
    expect(buildInfoDistance(wt, cacheFile(wt, cache))).toMatchObject({ changed: 0, global: 0, project: 3 });
    expect(buildInfoDistance(wt, path.join(wt, "missing.tsbuildinfo"))).toBeNull();
  });

  it("uses tsc's own file hash (not a guess) — also in a folder without node_modules", () => {
    expect(hasherKind(path.join(tmp, "wt-first"))).toBe("typescript");
    expect(restoreLine({ restored: false, reason: "own", own: { changed: 1, global: 0 }, shared: { changed: 2, global: 0 }, hashKind: "sha256" })).toMatch(/DHYAN: tsc ka hash nahi mila/);
  });

  it("weights a changed file by its importers (a hub costs more than a leaf)", () => {
    const wt = worktree("wt-weight");
    expect(tsc(wt).status).toBe(0);
    fs.writeFileSync(path.join(wt, "a.ts"), A_OK + "// edited\n"); // a.ts is imported by b.ts
    expect(buildInfoDistance(wt, path.join(wt, BUILD_INFO))).toMatchObject({ changed: 1, weight: 2 });
    fs.writeFileSync(path.join(wt, "a.ts"), A_OK);
    fs.writeFileSync(path.join(wt, "c.ts"), C + "// edited\n"); // nobody imports c.ts
    expect(buildInfoDistance(wt, path.join(wt, BUILD_INFO))).toMatchObject({ changed: 1, weight: 1 });
  });

  it("files on disk that only the other build info knows count as changed", () => {
    const wt = worktree("wt-new-files");
    expect(tsc(wt).status).toBe(0);
    fs.writeFileSync(path.join(wt, "d.ts"), "export const d = 1;\n");
    const own = path.join(wt, BUILD_INFO);
    expect(buildInfoDistance(wt, own, { alsoOnDisk: ["./d.ts", "./gone.ts"] })).toMatchObject({ changed: 1 });
    expect(buildInfoDistance(wt, own)).toMatchObject({ changed: 0 });
  });

  it("after a rebase the shared build info (new base) replaces the own one (old base)", () => {
    const wt = staleWorktree("wt-rebased");
    const r = restoreBuildInfo(wt, { dir: cache });
    expect(r).toMatchObject({ restored: true, reason: "shared", own: { changed: 2 }, shared: { changed: 0 } });
    expect(fs.readFileSync(path.join(wt, BUILD_INFO), "utf8")).toBe(fs.readFileSync(cacheFile(wt, cache), "utf8"));
    expect(restoreLine(r)).toMatch(/shared cache se shuru .*apni: 2 file badli; shared: 0 file badli/);
  });

  it("the own build info stays when it is the closer one", () => {
    const wt = worktree("wt-own-closer");
    fs.writeFileSync(path.join(wt, "b.ts"), B + "export const extra = 2;\n");
    expect(tsc(wt).status).toBe(0);
    const before = fs.readFileSync(path.join(wt, BUILD_INFO), "utf8");
    const r = restoreBuildInfo(wt, { dir: cache });
    expect(r).toMatchObject({ restored: false, reason: "own", own: { changed: 0 }, shared: { changed: 1 } });
    expect(fs.readFileSync(path.join(wt, BUILD_INFO), "utf8")).toBe(before);
  });

  it("a changed GLOBAL file (no import/export, like routes.d.ts) is flagged — it means a full re-check", () => {
    const wt = worktree("wt-global");
    fs.writeFileSync(path.join(wt, "g.ts"), "declare var routeCount: number;\n");
    expect(tsc(wt).status).toBe(0);
    fs.writeFileSync(path.join(wt, "g.ts"), "declare var routeCount: number;\ndeclare var routeCount2: number;\n");
    expect(buildInfoDistance(wt, path.join(wt, BUILD_INFO))).toMatchObject({ changed: 1, global: 1 });
  });

  it("a type error in an UNCHANGED importer is still caught after switching to the shared build info", () => {
    const wt = staleWorktree("wt-switch-err");
    fs.writeFileSync(path.join(wt, "a.ts"), "export function price(amount: number): string { return String(amount); }\n");
    const g = gate(wt);
    expect(g.restored.reason).toBe("shared");
    expect(g.green).toBe(false);
    expect(g.out).toMatch(/b\.ts\(2,\d+\): error TS2322/);
  });

  it("a type error in the changed file is caught when the own build info is kept", () => {
    const wt = worktree("wt-own-err");
    fs.writeFileSync(path.join(wt, "b.ts"), B + "export const extra = 2;\n");
    expect(tsc(wt).status).toBe(0);
    fs.writeFileSync(path.join(wt, "b.ts"), B + 'export const extra: number = "2";\n');
    const g = gate(wt);
    expect(g.restored.reason).toBe("own");
    expect(g.green).toBe(false);
    expect(g.out).toMatch(/b\.ts\(3,\d+\): error TS2322/);
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
    expect(body).toMatch(/if \(!full && step === TSC_STEPS\[TSC_STEPS\.length - 1\]\) \{\s*\/\*[^*]*\*\/\s*console\.log\(restoreLine\(restoreBuildInfo\(root\)\)\);\s*\}/);
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

/* R-2718 (12 Nov 2026): tsc follows the node_modules junction to its REAL path, so every node_modules
   file name in a build info carries the clone it was linked to. 12 Nov two clones were in use
   (WORKER-SESSION-PROMPT said new-reselleros, WORKER-STEPS reselleros-deploy): a build info from the
   other clone made all ~2,300 node_modules files (122 global) "new" — a full re-check, 1377–2488 s —
   while the restore line said "5 file badli", and both kinds saved over each other under one key. */
describe("R-2718 node_modules real path is part of the cache", () => {
  const TSCONFIG_TYPES = JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, incremental: true, target: "ES2022", lib: ["es2022"], types: ["glob1"], module: "esnext", moduleResolution: "bundler" },
    include: ["*.ts"],
  });
  function clone(name: string) {
    const nm = path.join(tmp, name, "node_modules");
    fs.mkdirSync(path.join(nm, "@types", "glob1"), { recursive: true });
    fs.writeFileSync(path.join(nm, "@types", "glob1", "package.json"), JSON.stringify({ name: "@types/glob1", version: "1.0.0", types: "index.d.ts" }));
    fs.writeFileSync(path.join(nm, "@types", "glob1", "index.d.ts"), "declare var glob1: number;\n");
    return nm;
  }
  function linked(name: string, target: string) {
    const wt = worktree(name);
    fs.writeFileSync(path.join(wt, "tsconfig.json"), TSCONFIG_TYPES);
    fs.writeFileSync(path.join(wt, "c.ts"), C + "export const g: number = glob1;\n");
    fs.symlinkSync(target, path.join(wt, "node_modules"), "junction");
    return wt;
  }
  const relink = (wt: string, target: string) => {
    fs.rmSync(path.join(wt, "node_modules")); // the link only (no recursive delete through it)
    fs.symlinkSync(target, path.join(wt, "node_modules"), "junction");
  };
  const tsc = (wt: string) => spawnSync(process.execPath, [TSC, "--noEmit", "-p", "."], { cwd: wt, encoding: "utf8" });
  let modsA: string, modsB: string, nmCache: string;

  beforeAll(() => {
    modsA = clone("clone-a"); modsB = clone("clone-b");
    nmCache = path.join(tmp, "nm-cache");
  });

  it("the build info names node_modules files by the junction's real path; the key follows it", () => {
    const a = linked("wt-nm-a", modsA), b = linked("wt-nm-b", modsB), a2 = linked("wt-nm-a2", modsA);
    expect(nodeModulesTarget(a)).toBe("../clone-a/node_modules");
    expect(tsc(a).status).toBe(0);
    const names: string[] = JSON.parse(fs.readFileSync(path.join(a, BUILD_INFO), "utf8")).fileNames;
    expect(names.some((n) => n.startsWith("../clone-a/node_modules/@types/glob1/"))).toBe(true);
    expect(cacheFile(a, nmCache)).toBe(cacheFile(a2, nmCache));
    expect(cacheFile(b, nmCache)).not.toBe(cacheFile(a, nmCache));
    /* a plain node_modules folder (or none) keeps the pre-R-2718 key */
    expect(cacheFile(path.join(tmp, "wt-first"), cache)).toBe(cacheFile(path.join(tmp, "wt-first"), cache, { legacy: true }));
  });

  it("a build info from another clone's node_modules is flagged foreign = full re-check; own clone = 0", () => {
    const wt = linked("wt-nm-foreign", modsA);
    expect(tsc(wt).status).toBe(0);
    const own = path.join(wt, BUILD_INFO);
    expect(buildInfoDistance(wt, own)).toMatchObject({ changed: 0, foreign: 0, modules: 0, global: 0 });
    relink(wt, modsB);
    const d = buildInfoDistance(wt, own);
    expect(d.foreign).toBeGreaterThan(0);
    expect(d.global).toBeGreaterThan(0);
    expect(restoreLine({ restored: false, reason: "own", own: d, shared: d })).toMatch(/doosre clone ke junction se, \d+ global — poora re-check/);
  });

  it("a changed GLOBAL node_modules file (e.g. @types after npm ci) counts as a global change", () => {
    const mods = clone("clone-c");
    const wt = linked("wt-nm-changed", mods);
    expect(tsc(wt).status).toBe(0);
    fs.writeFileSync(path.join(mods, "@types", "glob1", "index.d.ts"), "declare var glob1: number;\ndeclare var glob2: string;\n");
    expect(buildInfoDistance(wt, path.join(wt, BUILD_INFO))).toMatchObject({ changed: 0, modules: 1, global: 1, foreign: 0 });
  });

  it("the pre-R-2718 shared file is used only when it was written through the same node_modules", () => {
    const dir = path.join(tmp, "legacy-cache");
    const src = linked("wt-nm-legacy-src", modsA);
    expect(tsc(src).status).toBe(0);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(src, BUILD_INFO), cacheFile(src, dir, { legacy: true })); // as saved before R-2718

    const same = linked("wt-nm-legacy-same", modsA);
    const r1 = restoreBuildInfo(same, { dir });
    expect(r1).toMatchObject({ restored: true, legacy: true, shared: { foreign: 0 } });
    expect(restoreLine(r1)).toMatch(/R-2718 se pehle wali key/);

    const other = linked("wt-nm-legacy-other", modsB);
    const r2 = restoreBuildInfo(other, { dir });
    expect(r2).toMatchObject({ restored: false, reason: "empty", legacy: true });
    expect(r2.shared.foreign).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(other, BUILD_INFO))).toBe(false);
    expect(restoreLine(r2)).toMatch(/doosre clone ke node_modules se bani thi/);

    /* and a green run saves under the NEW key, so the two clones no longer overwrite each other */
    expect(tsc(other).status).toBe(0);
    expect(saveBuildInfo(other, { dir }).to).toBe(cacheFile(other, dir));
    expect(cacheFile(other, dir)).not.toBe(cacheFile(other, dir, { legacy: true }));
  });

  it("own vs shared: a shared build info from the other clone loses to the own one", () => {
    const dir = path.join(tmp, "own-vs-foreign");
    const b = linked("wt-nm-b-saver", modsB);
    expect(tsc(b).status).toBe(0);
    fs.mkdirSync(dir, { recursive: true });
    /* simulate the old poisoning: B's build info stored where A will look */
    const a = linked("wt-nm-a-own", modsA);
    fs.copyFileSync(path.join(b, BUILD_INFO), cacheFile(a, dir));
    expect(tsc(a).status).toBe(0);
    fs.writeFileSync(path.join(a, "c.ts"), C + "export const g: number = glob1;\nexport const more = 1;\n");
    const r = restoreBuildInfo(a, { dir });
    expect(r).toMatchObject({ restored: false, reason: "own", own: { foreign: 0, changed: 1 } });
    expect(r.shared.foreign).toBeGreaterThan(0);
  });

  it("type errors are still caught after the R-2718 restore (same tsc, only the starting point differs)", () => {
    const dir = path.join(tmp, "nm-safety");
    const first = linked("wt-nm-safe-first", modsA);
    expect(tsc(first).status).toBe(0);
    saveBuildInfo(first, { dir });
    const wt = linked("wt-nm-safe", modsA);
    fs.writeFileSync(path.join(wt, "a.ts"), "export function price(amount: number): string { return String(amount); }\n");
    expect(restoreBuildInfo(wt, { dir }).restored).toBe(true);
    const r = tsc(wt);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/b\.ts\(2,\d+\): error TS2322/);
  });
});

describe("R-2718 review fixes", () => {
  it("names are compared case-insensitively (tsc lowercases build-info names on Windows)", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "case-"));
    const f = path.join(dir, "x.tsbuildinfo");
    fs.writeFileSync(f, JSON.stringify({ fileNames: ["../clone-a/node_modules/@types/x/index.d.ts", "../Other/node_modules/y.d.ts", "./a.ts"], fileInfos: ["1", "2", "3"] }));
    expect(foreignCount(dir, f, { nm: "../Clone-A/node_modules", tsLib: "" })).toBe(1);
  });

  it("no own build info + a fresh-key file from another node_modules → not restored (names-only check)", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "plain-"));
    const wt = worktree("wt-plain-nm");
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.writeFileSync(cacheFile(wt, dir), JSON.stringify({ fileNames: ["../../reselleros-deploy/production/node_modules/@types/node/index.d.ts", "./a.ts"], fileInfos: [{ version: "1", affectsGlobalScope: true }, "2"] }));
    const r = restoreBuildInfo(wt, { dir });
    expect(r).toMatchObject({ restored: false, reason: "empty", shared: { foreign: 1 } });
    expect(fs.existsSync(path.join(wt, BUILD_INFO))).toBe(false);
  });
});
