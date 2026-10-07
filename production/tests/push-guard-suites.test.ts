import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { PUSH_GUARD_SUITES, PUSH_GUARD_BUDGET_MS, failedSuites } from "../scripts/ops/push-guard-suites.mjs";

// R-385 (7 Oct 2026): `worker-lock.mjs push` runs these repo-scan / ratchet suites after the
// rebase, because twice today a worker's push broke a scan test outside its own area.
const root = path.resolve(__dirname, "..");
const list: string[] = PUSH_GUARD_SUITES;

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
    expect(list.length).toBeLessThanOrEqual(80);
    expect(PUSH_GUARD_BUDGET_MS).toBe(90_000);
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
    const tsc = push.indexOf("tscWithTurn(card)");
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
