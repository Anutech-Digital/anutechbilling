import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { PUSH_GUARD_SUITES, CI_ONLY_GUARD_SUITES, PUSH_GUARD_BUDGET_MS, failedSuites, slowestSuites } from "../scripts/ops/push-guard-suites.mjs";

// R-385 (7 Oct 2026): `worker-lock.mjs push` runs these repo-scan / ratchet suites after the
// rebase, because twice today a worker's push broke a scan test outside its own area.
const root = path.resolve(__dirname, "..");
const list: string[] = PUSH_GUARD_SUITES;

/** Minimal glob → match for vitest exclude entries: `**` any depth (incl. none), `*` and `?` within a segment, `{a,b}`. */
function globMatch(glob: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, out); }
    else out.push(path.relative(root, full).replace(/\\/g, "/"));
  }
  return out;
}

describe("push guard suites (R-385)", () => {
  it("every listed suite exists — a renamed test must be renamed here too", () => {
    const missing = list.filter((f) => !fs.existsSync(path.join(root, f)));
    expect(missing).toEqual([]);
  });

  it("has no duplicates and stays a short list (the push waits for it)", () => {
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(10);
    expect(list.length).toBeLessThanOrEqual(88); // R-1973: 74 → 84 with the src/site scans; R-2443: 89 → 80 (+nav-coverage); R-2564: +2 tiny source-cache guards (~0.1 s); R-2571: +6 migration/security scans
    expect(PUSH_GUARD_BUDGET_MS).toBe(60_000); // R-2443: 90 → 60 s
  });

  describe("R-2443: slow feature-wiring files run in CI only — never dropped", () => {
    const ciOnly: string[] = CI_ONLY_GUARD_SUITES;

    it("every CI-only file exists, is listed once, and is NOT run by the push", () => {
      expect(ciOnly.length).toBeGreaterThan(0);
      expect(ciOnly.filter((f) => !fs.existsSync(path.join(root, f)))).toEqual([]);
      expect(new Set(ciOnly).size).toBe(ciOnly.length);
      expect(ciOnly.filter((f) => list.includes(f))).toEqual([]);
    });

    it("no *ratchet* and none of the files that once turned CI red moved to CI-only", () => {
      expect(ciOnly.filter((f) => /ratchet/.test(f))).toEqual([]);
      for (const f of ["src/lib/app-url.test.ts", "src/lib/nav-coverage.test.ts", "src/site/page-metadata.test.ts", "src/app/(app)/quotes/invoice-link.test.ts", "tests/gen-deploy-db.test.ts"]) {
        expect(list).toContain(f);
      }
    });

    it("CI still runs every CI-only file: ci.yml runs `npm run test`, which is `vitest run` over src/ + tests/", () => {
      const ci = fs.readFileSync(path.join(root, "..", ".github", "workflows", "ci.yml"), "utf8");
      expect(ci).toMatch(/run: npm run test -- --shard=\$\{\{ matrix\.shard \}\}\/2/);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      expect(pkg.scripts.test).toBe("vitest run");
      const cfg = fs.readFileSync(path.join(root, "vitest.config.ts"), "utf8");
      expect(cfg).toContain(`include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"]`);
      const exclude = /exclude:\s*\[([^\]]*)\]/.exec(cfg)?.[1] ?? "";
      const excluded = [...exclude.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(excluded.length).toBeGreaterThan(0);
      /* Entries are globs: read each the widest way (as given, as a folder, anywhere in the tree). */
      const hits = (f: string) => excluded.filter((e) =>
        [e, `${e}/**`, `**/${e}`, `**/${e}/**`].some((g) => globMatch(g, f)));
      for (const f of ciOnly) {
        expect(f).toMatch(/^(src|tests)\/.+\.test\.tsx?$/);
        expect(hits(f)).toEqual([]);
      }
      expect(hits("tests/isolation/x.test.ts")).not.toEqual([]); // the matcher really sees an exclude
      expect(globMatch("**/*.wiring.test.ts", "src/lib/leads/unbounded-reads.wiring.test.ts")).toBe(true);
      expect(globMatch("src/site/**/*-priceable*", "src/site/cart-lines-priceable.test.ts")).toBe(true);
      expect(globMatch("src/*.ts", "src/lib/x.ts")).toBe(false);
    });
  });

  it("R-2443: `push-guard-suites.mjs --ci-only` prints the CI-only list for the fast gate", () => {
    const out = execFileSync(process.execPath, [path.join(root, "scripts/ops/push-guard-suites.mjs"), "--ci-only"], { cwd: root, encoding: "utf8" });
    expect(out.trim().split(/\r?\n/)).toEqual(CI_ONLY_GUARD_SUITES);
    const quiet = execFileSync(process.execPath, [path.join(root, "scripts/ops/push-guard-suites.mjs")], { cwd: root, encoding: "utf8" });
    expect(quiet).toBe("");
  });

  it("R-2443: names the slowest files of a vitest json report, slowest first", () => {
    const json = { testResults: [
      { name: "C:/Users/x/w/production/src/a.test.ts", startTime: 1000, endTime: 1500 },
      { name: "C:/Users/x/w/production/src/b.test.ts", startTime: 1000, endTime: 41000 },
      { name: "C:/Users/x/w/production/src/c.test.ts", startTime: 1000, endTime: 3000 },
      { name: "C:/Users/x/w/production/src/d.test.ts" },
    ] };
    expect(slowestSuites(json, "c:\\Users\\x\\w\\production", 2)).toEqual([
      { file: "src/b.test.ts", ms: 40000 },
      { file: "src/c.test.ts", ms: 2000 },
    ]);
    expect(slowestSuites(json, "c:\\Users\\x\\w\\production").at(-1)).toEqual({ file: "src/d.test.ts", ms: 0 });
    expect(slowestSuites({}, "/x")).toEqual([]);
  });

  it("R-2443: an over-budget push prints the slowest files", () => {
    const src = fs.readFileSync(path.join(root, "scripts/ops/worker-lock.mjs"), "utf8");
    const fn = src.slice(src.indexOf("export function runGuardSuites"), src.indexOf("async function pushWithTurn"));
    expect(fn).toContain("slowestSuites(json, root, 5)");
    expect(fn).toMatch(/if \(ms > PUSH_GUARD_BUDGET_MS\) \{[\s\S]*sabse dheemi/);
  });

  it("R-1817: the Gemini scans run on push, the slow retry-timer suite does not", () => {
    expect(list).toContain("src/lib/ai/gemini-one-door.test.ts");
    expect(list).not.toContain("src/lib/ai/gemini.test.ts");
    const scans = fs.readFileSync(path.join(root, "src/lib/ai/gemini-one-door.test.ts"), "utf8");
    expect(scans).toContain("generativelanguage.googleapis.com");
    expect(fs.readFileSync(path.join(root, "src/lib/ai/gemini.test.ts"), "utf8")).not.toContain("readdirSync");
  });

  it("R-1973: the src/site scan that turned CI red at 8ca1bcbe runs on push", () => {
    expect(list).toContain("src/site/page-metadata.test.ts");
    expect(list).toContain("src/site/lib/public-metadata-r1631.test.ts");
  });

  it("R-2571: every src/lib/security test that reads supabase/migrations runs on push", () => {
    // 7 Nov 2026: R-2570's raw auth.role() list reached CI — cloudsql-auth-shim-scan was not on the list.
    const security = walk(path.join(root, "src", "lib", "security")).filter((f) => /\.test\.tsx?$/.test(f));
    const migrationScans = security.filter((f) => /supabase\/migrations/.test(fs.readFileSync(path.join(root, f), "utf8")));
    expect(migrationScans).toContain("src/lib/security/cloudsql-auth-shim-scan.test.ts");
    expect(migrationScans.length).toBeGreaterThanOrEqual(7);
    expect(migrationScans.filter((f) => !list.includes(f))).toEqual([]);
  });

  it("includes the two suites that broke CI on 7 Oct", () => {
    expect(list).toContain("src/lib/a11y/a11y-ratchet.test.tsx");
    expect(list).toContain("src/app/(app)/quotes/invoice-link.test.ts");
  });

  it("every *ratchet* test in the repo is on the list", () => {
    const ratchets = [...walk(path.join(root, "src")), ...walk(path.join(root, "tests"))]
      .filter((f) => /ratchet[^/]*\.test\.tsx?$/.test(f));
    expect(ratchets.length).toBeGreaterThan(0);
    expect(ratchets.filter((f) => !list.includes(f))).toEqual([]);
  });

  it("reads the failed files out of a vitest json report, relative to production/", () => {
    const json = { testResults: [
      { name: "C:/Users/x/w/production/src/lib/a11y/a11y-ratchet.test.tsx", status: "failed" },
      { name: "C:/Users/x/w/production/src/lib/nav.test.ts", status: "passed" },
    ] };
    expect(failedSuites(json, "c:\\Users\\x\\w\\production")).toEqual(["src/lib/a11y/a11y-ratchet.test.tsx"]);
    expect(failedSuites({}, "/x")).toEqual([]);
  });

  it("worker-lock push runs the guard after tsc and refuses the push on failure", () => {
    const src = fs.readFileSync(path.join(root, "scripts/ops/worker-lock.mjs"), "utf8");
    const push = src.slice(src.indexOf("async function pushWithTurn"));
    const tsc = push.indexOf("tscWithTurn(card"); // R-1960: tscWithTurn(card, { full: ciFlags.fullTsc })
    const guard = push.indexOf("runGuardSuites(card)");
    const gitPush = push.indexOf("git push");
    expect(tsc).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(tsc);
    expect(gitPush).toBeGreaterThan(guard);
    expect(push.slice(guard, gitPush)).toContain("process.exit(5)");
  });

  it("no shebang in the .mjs files vitest imports", () => {
    for (const f of ["scripts/ops/push-guard-suites.mjs", "scripts/ops/worker-lock.mjs", "scripts/ops/gen-deploy-db.mjs"]) {
      expect(fs.readFileSync(path.join(root, f), "utf8").startsWith("#!")).toBe(false);
    }
  });
});
