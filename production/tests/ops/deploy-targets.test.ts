/**
 * R-1604 (19 Oct 2026) — the repo has exactly two deploy targets: live (`resellersos`) and
 * staging (`resellersos-staging`), both reached through a gate (deploy.sh → deploy-gate.mjs,
 * staging-train). Until this card a third path lived on: deploy-test.cmd sent a laptop's
 * UNCOMMITTED code to the old `reselleros-test` app with no test run at all, and two
 * cloudbuild.test.yaml files described that app with two different URLs. vercel.json and
 * apphosting.yaml looked like cron/deploy config but did nothing on Cloud Run.
 *
 * This guard fails if any of them comes back, or if a deploy-shaped file names a Cloud Run
 * service other than the two real ones.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROD = path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(PROD, "..");

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "playwright-report", "test-results", "docs", ".claude"]);
const ALLOWED_SERVICES = new Set(["resellersos", "resellersos-staging"]);
/** Files that must never come back (any folder). */
const RETIRED_FILES = new Set(["deploy-test.cmd", "cloudbuild.test.yaml", "vercel.json", "apphosting.yaml"]);
/** Names of the retired test app and its GCP project — must not appear in any deploy-shaped file. */
const RETIRED_TARGETS = [/reselleros-test/i, /boxwood-victor-453804/i];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

/** Deploy-shaped: Cloud Build configs, shell/cmd/ps1 scripts, CI workflows, ops scripts. */
function isDeployShaped(f: string): boolean {
  const r = rel(f);
  const base = path.basename(f);
  return (
    /^cloudbuild.*\.ya?ml$/i.test(base) ||
    /\.(sh|cmd|bat|ps1)$/i.test(base) ||
    r.startsWith(".github/workflows/") ||
    r.startsWith("production/scripts/ops/") && /\.(mjs|cjs|js)$/.test(base) && !/\.test\./.test(base)
  );
}

const files = walk(ROOT);
const deployFiles = files.filter(isDeployShaped);

/** Service names a file deploys to: `_SERVICE: x`, `gcloud run deploy x`, `SERVICE=x` / `${SERVICE:-x}`. */
function servicesIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*_SERVICE:\s*["']?([A-Za-z0-9_-]+)/gm,
    /run\s+deploy\s+["']?([A-Za-z0-9_][A-Za-z0-9_-]*)/g, // a flag (--source) or $VAR is not a name
    /\bSERVICE=["']?(?:\$\{SERVICE:-)?([A-Za-z0-9_-]+)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1]);
  return found;
}

describe("deploy targets (R-1604)", () => {
  it("the retired deploy/config files are gone", () => {
    const back = files.filter((f) => RETIRED_FILES.has(path.basename(f))).map(rel);
    expect(back, "retired deploy file came back — use deploy.sh (live) or staging-train (staging)").toEqual([]);
  });

  it("no deploy-shaped file names the retired reselleros-test app or its project", () => {
    const hits: string[] = [];
    for (const f of deployFiles) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of RETIRED_TARGETS) if (re.test(text)) hits.push(`${rel(f)} (${re.source})`);
    }
    expect(hits).toEqual([]);
  });

  it("every Cloud Run service a deploy-shaped file names is live or staging", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of deployFiles) {
      for (const s of servicesIn(fs.readFileSync(f, "utf8"))) {
        seen++;
        if (!ALLOWED_SERVICES.has(s)) bad.push(`${rel(f)}: ${s}`);
      }
    }
    expect(seen, "scanner found no service at all — it is not looking at cloudbuild.yaml").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("the scanner itself catches the old shapes", () => {
    expect(servicesIn("set SERVICE=reselleros-test")).toEqual(["reselleros-test"]);
    expect(servicesIn("  _SERVICE: reselleros-test")).toEqual(["reselleros-test"]);
    expect(servicesIn("gcloud run deploy other-app --image=x")).toEqual(["other-app"]);
    expect(servicesIn('SERVICE="${SERVICE:-resellersos}"')).toEqual(["resellersos"]);
    expect(isDeployShaped(path.join(ROOT, "production", "deploy-test.cmd"))).toBe(true);
    expect(isDeployShaped(path.join(ROOT, "cloudbuild.yaml"))).toBe(true);
  });
});
