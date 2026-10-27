/**
 * R-1818 (security audit 24 Oct 2026): every company-scoped cron asks the automation gate which
 * companies it may work on.
 *
 * gatedCron() runs a route inside a pass that allows only some companies (the ones with the job
 * switched on, or the caller's own company for "Run now"), but it cannot stop a route that loops
 * over every company itself — the route must skip the others with cronTenantAllowed(). The
 * cold-calls cron did not, so one company's "Run now" placed live calls for every company.
 *
 * The rule, per src/app/api/cron/<job>/route.ts whose gatedCron job is scope "tenant":
 * the route calls cronTenantAllowed(), or a module it imports from @/lib or @/server does
 * (indiamart-leads, lead-finder keep the loop in their lib). The gate itself and the message
 * sender (a second wall, not the route's own filter) do not count.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AUTOMATION_JOBS, type AutomationJob } from "./jobs";

const ROOT = process.cwd();
const CRON_DIR = path.join(ROOT, "src/app/api/cron");
const NOT_THE_ROUTES_OWN_FILTER = new Set([
  "src/lib/automation/cron-gate.ts",
  "src/lib/messaging/index.ts",
]);

function resolveImport(spec: string): string | null {
  if (!spec.startsWith("@/lib/") && !spec.startsWith("@/server/")) return null;
  const base = path.join(ROOT, "src", spec.slice(2));
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const usesGate = (src: string) => /\bcronTenantAllowed\s*\(/.test(src);

function tenantCronRoutes(): { job: AutomationJob; file: string }[] {
  const out: { job: AutomationJob; file: string }[] = [];
  for (const dir of fs.readdirSync(CRON_DIR)) {
    const file = path.join(CRON_DIR, dir, "route.ts");
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, "utf8").match(/gatedCron\(\s*"([a-z0-9-]+)"/);
    if (!m) continue;
    const job = m[1] as AutomationJob;
    if (AUTOMATION_JOBS[job]?.scope === "tenant") out.push({ job, file });
  }
  return out;
}

describe("company-scoped crons use the automation gate (R-1818)", () => {
  const routes = tenantCronRoutes();

  it("finds the company-scoped cron routes", () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.map((r) => r.job)).toContain("cold-calls");
  });

  it.each(routes.map((r) => [r.job, r.file] as const))("%s skips companies the gate does not allow", (_job, file) => {
    const src = fs.readFileSync(file, "utf8");
    if (usesGate(src)) return;
    const imported = [...src.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => resolveImport(m[1]))
      .filter((f): f is string => f !== null && !NOT_THE_ROUTES_OWN_FILTER.has(rel(f)));
    const viaLib = imported.filter((f) => usesGate(fs.readFileSync(f, "utf8")));
    expect(
      viaLib.length,
      `${rel(file)} loops over companies without cronTenantAllowed(tenantId) — add ` +
        "`if (!cronTenantAllowed(tenantId)) continue;` (R-897), or a switched-off company still gets the job",
    ).toBeGreaterThan(0);
  });
});
