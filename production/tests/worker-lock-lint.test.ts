// R-2568 (7 Nov 2026): `worker-lock push` runs CI's lint ratchet (twice on 7 Nov a push went red in CI
// only on `npm run lint:ratchet`: R-2558 max-lines 26/25, R-2566 react-hooks/exhaustive-deps 12/10).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs script, no types
import { ratchetVerdict, cachedCounts, summarize, total, trackedLintFiles, configKey } from "../scripts/lint-ratchet.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { startLintRatchet, lintRatchetVerdict, LINT_RATCHET_FAILED } from "../scripts/ops/worker-lock.mjs";

const root = path.resolve(__dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r2568-lint-"));

describe("lint ratchet verdict (the check CI runs)", () => {
  const base = { "max-lines": 25, "react-hooks/exhaustive-deps": 10, "@typescript-eslint/no-explicit-any": 113 };

  it("R-2558's 26/25 max-lines is OVER → exit 1 with CI's text", () => {
    const v = ratchetVerdict({ "max-lines": 26, "react-hooks/exhaustive-deps": 10 }, base);
    expect(v.code).toBe(1);
    expect(v.over).toEqual(["max-lines"]);
    expect(v.lines).toContain("  26 / 25   max-lines  OVER");
    expect(v.errLines.join("\n")).toContain("Lint ratchet FAILED — more warnings than baseline for: max-lines");
    expect(v.errLines.join("\n")).toContain("Do not raise lint-baseline.json to pass.");
  });

  it("R-2566's 12/10 exhaustive-deps is OVER; equal and below pass", () => {
    expect(ratchetVerdict({ "react-hooks/exhaustive-deps": 12 }, base).over).toEqual(["react-hooks/exhaustive-deps"]);
    const ok = ratchetVerdict({ "max-lines": 25, "@typescript-eslint/no-explicit-any": 90 }, base);
    expect(ok.code).toBe(0);
    expect(ok.lines).toContain("  90 / 113  @typescript-eslint/no-explicit-any  below (run --update)");
  });

  it("a rule not in the baseline has a ceiling of 0; any ESLint error fails", () => {
    expect(ratchetVerdict({ "no-console": 1 }, base).over).toEqual(["no-console"]);
    const e = ratchetVerdict({}, base, 2);
    expect(e.code).toBe(1);
    expect(e.errLines.join("\n")).toContain("2 ESLint error(s) — errors are never baselined.");
  });
});

describe("worker-lock push runs it", () => {
  it("a red ratchet refuses the push and shows the script's own text; green passes", async () => {
    const dir = tmp();
    try {
      const red = path.join(dir, "red.mjs");
      fs.writeFileSync(red, "console.log('  26 / 25   max-lines  OVER');\nconsole.error('Lint ratchet FAILED — more warnings than baseline for: max-lines');\nprocess.exit(1);\n");
      const r = await startLintRatchet(dir, { script: red });
      expect(r.code).toBe(1);
      const v = lintRatchetVerdict(r);
      expect(v.ok).toBe(false);
      expect(v.message).toContain("Lint ratchet FAILED — more warnings than baseline for: max-lines");
      expect(v.message).toContain("26 / 25   max-lines  OVER");
      const green = path.join(dir, "green.mjs");
      fs.writeFileSync(green, "console.log('(lint-ratchet --cache: 2 file(s) linted, 4885 from cache, 3.1 s)');\nprocess.exit(0);\n");
      expect(lintRatchetVerdict(await startLintRatchet(dir, { script: green })).ok).toBe(true);
      /* exit 0 WITHOUT the summary line = it never linted (e.g. its entry check failed) → red */
      const silent = path.join(dir, "silent.mjs");
      fs.writeFileSync(silent, "process.exit(0);\n");
      expect(lintRatchetVerdict(await startLintRatchet(dir, { script: silent })).ok).toBe(false);
      /* a crash (missing script) is red too — CI would not be green either */
      expect(lintRatchetVerdict(await startLintRatchet(dir, { script: path.join(dir, "missing.mjs") })).ok).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("is passed --cache, and runs the same script CI's `npm run lint:ratchet` runs", async () => {
    const calls: unknown[][] = [];
    const fake = (...a: unknown[]) => { calls.push(a); return { on: (ev: string, cb: (c: number) => void) => { if (ev === "exit") setTimeout(() => cb(0), 0); } }; };
    expect((await startLintRatchet(root, { spawnFn: fake })).code).toBe(0);
    expect(calls[0][1]).toEqual([path.join(root, "scripts", "lint-ratchet.mjs"), "--cache"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["lint:ratchet"]).toBe("node scripts/lint-ratchet.mjs");
    expect(fs.readFileSync(path.join(root, "..", ".github", "workflows", "ci.yml"), "utf8")).toContain("npm run lint:ratchet");
  });

  it("runGuardSuites starts it before the guard vitest run and refuses on red", () => {
    const src = fs.readFileSync(path.join(root, "scripts/ops/worker-lock.mjs"), "utf8");
    const fn = src.slice(src.indexOf("export function runGuardSuites"), src.indexOf("export const LINT_RATCHET_FAILED"));
    const start = fn.indexOf("startLintRatchet(root)");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(fn.indexOf("execFileSync(process.execPath"));
    expect(fn).toMatch(/lintRatchetVerdict\(await lint\)[\s\S]*if \(!lv\.ok\) failed\.push\(LINT_RATCHET_FAILED\)/);
    /* pushWithTurn exits 5 on any failed entry (tests/push-guard-suites.test.ts) — and names the ratchet */
    const push = src.slice(src.indexOf("async function pushWithTurn"));
    expect(push).toContain("failed.includes(LINT_RATCHET_FAILED)");
    expect(LINT_RATCHET_FAILED).toContain("npm run lint:ratchet");
  });
});

describe("lint-ratchet --cache: per-file results keyed by path + blob + config", () => {
  type Msg = { severity: number; ruleId: string | null; line: number; message: string };
  const W = (ruleId: string): Msg => ({ severity: 1, ruleId, line: 1, message: "w" });
  const fakeRoot = path.resolve(os.tmpdir(), "r2568-fake-root");
  const setup = () => {
    const dir = tmp();
    const msgs: Record<string, Msg[]> = {
      "src/a.ts": [W("max-lines")],
      "src/b.tsx": [W("react-hooks/exhaustive-deps"), W("react-hooks/exhaustive-deps")],
      "src/c.ts": [],
    };
    const calls: string[][] = [];
    const lint = async (abs: string[]) => {
      const rels = abs.map((p) => path.relative(fakeRoot, p).split(path.sep).join("/"));
      calls.push(rels);
      return rels.map((r) => ({ filePath: path.join(fakeRoot, r), messages: msgs[r] ?? [] }));
    };
    const tracked = (dirty: string[] = [], blobB = "b1") => ({
      files: [{ path: "src/a.ts", blob: "a1" }, { path: "src/b.tsx", blob: blobB }, { path: "src/c.ts", blob: "c1" }, { path: "src/server/db/generated/x.ts", blob: "g1" }],
      dirty: new Set(dirty),
    });
    const ignored = async (p: string) => p.startsWith("src/server/db/generated/");
    const run = (o: { dirty?: string[]; blobB?: string; key?: string } = {}) =>
      cachedCounts({ root: fakeRoot, cacheFile: path.join(dir, "c.json"), lint, ignored, tracked: tracked(o.dirty, o.blobB), key: o.key ?? "k1" });
    return { dir, msgs, calls, run };
  };

  it("first run lints every non-ignored file; the next one lints nothing and gives the same totals", async () => {
    const { dir, calls, run } = setup();
    try {
      const a = await run();
      expect(calls).toEqual([["src/a.ts", "src/b.tsx", "src/c.ts"]]);
      expect(a.counts).toEqual({ "max-lines": 1, "react-hooks/exhaustive-deps": 2 });
      const b = await run();
      expect(calls.length).toBe(1);
      expect(b.counts).toEqual(a.counts);
      expect([b.linted, b.cached]).toEqual([0, 3]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("a changed blob, a file that differs from HEAD, or a new config is linted fresh — never served stale", async () => {
    const { dir, msgs, calls, run } = setup();
    try {
      await run();
      msgs["src/b.tsx"].push(W("react-hooks/exhaustive-deps")); // R-2566-style: one more warning
      expect((await run({ blobB: "b2" })).counts["react-hooks/exhaustive-deps"]).toBe(3);
      expect(calls.at(-1)).toEqual(["src/b.tsx"]);
      msgs["src/a.ts"].push(W("max-lines"));
      const d = await run({ blobB: "b2", dirty: ["src/a.ts"] });
      expect(calls.at(-1)).toEqual(["src/a.ts"]);
      expect(d.counts["max-lines"]).toBe(2);
      /* the dirty result is not cached: the same blob clean again is served from the commit's entry */
      msgs["src/a.ts"].pop();
      expect((await run({ blobB: "b2" })).counts["max-lines"]).toBe(1);
      await run({ blobB: "b2", key: "k2" });
      expect(calls.at(-1)).toEqual(["src/a.ts", "src/b.tsx", "src/c.ts"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("errors are kept as CI prints them, and a file with no result is never counted clean", async () => {
    expect(summarize("src/x.ts", [{ severity: 2, ruleId: null, line: 3, message: "Parsing error" }, W("max-lines")]))
      .toEqual({ w: { "max-lines": 1 }, e: ["ERROR src/x.ts:3  (parse)  Parsing error"] });
    expect(total([{ w: { a: 1 }, e: [] }, { w: { a: 2, b: 1 }, e: ["E"] }])).toEqual({ counts: { a: 3, b: 1 }, errorLines: ["E"] });
    const dir = tmp();
    try {
      const r = cachedCounts({ root: fakeRoot, cacheFile: path.join(dir, "c.json"), lint: async () => [], ignored: async () => false, tracked: { files: [{ path: "src/a.ts", blob: "a1" }], dirty: new Set() }, key: "k" });
      await expect(r).rejects.toThrow(/no result for src\/a\.ts/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  /* A REAL git repo shaped like ours (app in production/, run from there): the review of 7 Nov found
     `git diff --name-only` prints repo-top paths (production/src/…) while ls-tree prints src/… — so an
     edited file was never seen as changed. This test runs the real commands. */
  it("real git, app in a subfolder: HEAD files + blob, edited/staged/untracked are dirty, deleted throws", () => {
    const top = tmp();
    try {
      const app = path.join(top, "production");
      const g = (...a: string[]) => execFileSync("git", a, { cwd: app, encoding: "utf8", stdio: "pipe" });
      fs.mkdirSync(path.join(app, "src", "lib"), { recursive: true });
      fs.mkdirSync(path.join(app, "src", ".hidden"), { recursive: true });
      for (const [f, t] of [["src/a.ts", "a\n"], ["src/lib/b.tsx", "b\n"], ["src/c.ts", "c\n"], ["src/x.css", "x\n"], ["src/.hidden/z.ts", "z\n"]]) fs.writeFileSync(path.join(app, f), t);
      execFileSync("git", ["init", "-q", "-b", "main", top], { stdio: "pipe" });
      g("add", "-A");
      g("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "base");
      const blobA = g("rev-parse", "HEAD:production/src/a.ts").trim();
      let t = trackedLintFiles(app);
      expect(t.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/a.ts", "src/c.ts", "src/lib/b.tsx"]);
      expect(t.files.find((f: { path: string }) => f.path === "src/a.ts").blob).toBe(blobA);
      expect([...t.dirty]).toEqual([]);
      fs.writeFileSync(path.join(app, "src/a.ts"), "a2\n"); // edited, not staged
      fs.writeFileSync(path.join(app, "src/lib/b.tsx"), "b2\n");
      g("add", "src/lib/b.tsx"); // staged, not committed
      fs.writeFileSync(path.join(app, "src/new.ts"), "n\n"); // untracked
      t = trackedLintFiles(app);
      expect([...t.dirty].sort()).toEqual(["src/a.ts", "src/lib/b.tsx", "src/new.ts"]);
      expect(t.files.find((f: { path: string }) => f.path === "src/new.ts")).toEqual({ path: "src/new.ts", blob: null });
      fs.rmSync(path.join(app, "src/c.ts"));
      expect(() => trackedLintFiles(app)).toThrow(/deleted but not committed.*src\/c\.ts/);
    } finally { fs.rmSync(top, { recursive: true, force: true }); }
  });

  it("the config key changes with any ESLint config file, package.json or the lockfile", () => {
    const dir = tmp();
    try {
      const files: Record<string, string> = { ".eslintrc.json": "{}", "package.json": "{}", "package-lock.json": "{}", "src/x/.eslintrc.json": "{}" };
      const write = () => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
      const git = () => Object.keys(files).join("\0") + "\0";
      write();
      const seen = new Set([configKey(dir, git)]);
      for (const f of Object.keys(files)) {
        files[f] = '{"changed":1}';
        write();
        const k = configKey(dir, git);
        expect(seen.has(k), f).toBe(false);
        seen.add(k);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
