/**
 * R-730 (19 Oct 2026) — no NEXT_PUBLIC_ variable may hold an admin allowlist.
 *
 * Next.js copies every literal `process.env.NEXT_PUBLIC_*` read into the browser bundle at
 * build time. lib/platform.ts read NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS, so the list of
 * god-mode (cross-tenant) addresses was public to anyone who opened the app's JS. The list
 * is server-only now and the browser asks GET /api/platform/whoami about itself.
 *
 * This scan fails if:
 *   1. any source / config file names a NEXT_PUBLIC_ variable that looks like an admin,
 *      super-user, staff or allowlist setting;
 *   2. a "use client" file imports the allowlist helpers from @/lib/platform (in the browser
 *      they would only ever see the default, and invite someone to "fix" it with NEXT_PUBLIC_).
 * Comments are stripped first — only code reaches a bundle. Repo-scan → listed in
 * scripts/ops/push-guard-suites.mjs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");          // production/
const SRC = path.join(ROOT, "src");
const CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", ".env.example", "Dockerfile"];

const ADMIN_PUBLIC_ENV = /NEXT_PUBLIC_[A-Z0-9_]*(ADMIN|SUPERUSER|SUPER_USER|STAFF|ALLOWLIST|WHITELIST|GOD)[A-Z0-9_]*/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** Comments out — a note that NAMES the old variable ships nothing. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("R-730: admin allowlists never go to the browser", () => {
  const files = walk(SRC);

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no source or config file names a NEXT_PUBLIC_ admin/allowlist variable", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const m = code(fs.readFileSync(f, "utf8")).match(ADMIN_PUBLIC_ENV);
      if (m) offenders.push(`${rel(f)}: ${m[0]}`);
    }
    for (const name of CONFIG_FILES) {
      const f = path.join(ROOT, name);
      if (!fs.existsSync(f)) continue;
      const m = fs.readFileSync(f, "utf8").match(ADMIN_PUBLIC_ENV);
      if (m) offenders.push(`${name}: ${m[0]}`);
    }
    expect(offenders, "Admin lists must be server-only env (e.g. PLATFORM_ADMIN_EMAILS) — see lib/platform.ts").toEqual([]);
  });

  it("no \"use client\" file imports the platform-admin allowlist helpers", () => {
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      if (!/^\s*["']use client["']/.test(src)) return false;
      return /import\s*\{[^}]*\b(isPlatformAdmin|platformAdminEmails)\b[^}]*\}\s*from\s*["']@\/lib\/platform["']/.test(src);
    }).map(rel);
    expect(offenders, "Ask GET /api/platform/whoami from the browser instead").toEqual([]);
  });

  it("the pattern catches the old variable (mutation check)", () => {
    expect(ADMIN_PUBLIC_ENV.test("process.env." + "NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS")).toBe(true);
    expect(ADMIN_PUBLIC_ENV.test("process.env.NEXT_PUBLIC_APP_URL")).toBe(false);
  });
});
