/**
 * R-1552 guard (18 Oct 2026): no cron route accepts a signed-in USER as a stand-in for the
 * cron secret.
 *
 * A cron works across companies; a user belongs to one. The four provisioning crons took
 * "CRON_SECRET or any signed-in owner" and then ran for every company. This scan fails when a
 * route under src/app/api/cron reads a user session (supabase auth.getUser, getCurrentUser,
 * requireUser…, the cookie-bound createClient) or asks the gate to call it without a bearer —
 * unless it is listed below with the reason it is scoped to the caller's own tenant.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CRON = join(process.cwd(), "src", "app", "api", "cron");

/** route (relative to api/cron) → how it is held to the caller's own tenant. Keep it short. */
const ALLOWED: Record<string, { why: string; mustContain: RegExp }> = {
  "health-digest/route.ts": {
    why: "R-112 dry-run preview for a signed-in owner: read-only, own tenant only",
    mustContain: /preview\(me\.user\.tenant_id/,
  },
};

const SESSION = [
  /\bauth\.getUser\s*\(/,
  /\bgetCurrentUser\s*\(/,
  /\brequire(?:User|Owner|Role|Aal2|Session)\w*\s*\(/,
  /\bcreateClient\s*\(\s*\)/,
  /\bwithoutBearer\s*:/,
];

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("R-1552: cron routes take the cron secret, not a user session", () => {
  const files = routes(CRON);

  it("finds the cron routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(27);
  });

  it.each(files.map((f) => relative(CRON, f).split(sep).join("/")))("%s", (rel) => {
    const src = strip(readFileSync(join(CRON, rel), "utf8"));
    const hits = SESSION.filter((re) => re.test(src)).map(String);
    const allowed = ALLOWED[rel];
    if (!allowed) {
      expect(hits, `${rel} reads a user session — a cron must take ONLY the CRON_SECRET bearer (R-1552)`).toEqual([]);
      return;
    }
    expect(src, `${rel}: allowed because "${allowed.why}", but that scoping is gone`).toMatch(allowed.mustContain);
  });

  it("the provisioning crons do the bearer check themselves too", () => {
    for (const job of ["register-domains", "renew-domains", "provision-hosting", "renew-hosting"]) {
      const src = strip(readFileSync(join(CRON, job, "route.ts"), "utf8"));
      expect(src, job).toMatch(/cronAuthFailure\(req, process\.env\.CRON_SECRET\)/);
      expect(src, job).toMatch(/provisioningResponse\(/);
    }
  });
});
