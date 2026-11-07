/**
 * R-059 (1 Oct 2026): two real owner passwords sat in the login page's dev demo list (and in a
 * setup script and the tracker). This keeps any password literal out of the files where one
 * landed before — the login page, the auth pages and the setup scripts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const root = process.cwd();
const authDir = join(root, "src", "app", "(auth)");
const scriptsDir = join(root, "scripts");

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, exts));
    else if (exts.some((x) => e.name.endsWith(x)) && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

/* `password: "…"`, `password = '…'`, `PASSWORD = "…"` with 6+ characters — a literal, not an
   env read or a form field name. */
const LITERAL = /\bpassword\w*\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i;

describe("no password literals in source (R-059)", () => {
  /* setup-e2e-tenants.mjs creates two DEDICATED test tenants with fixed test-only credentials
     that e2e/fixtures read — not a person's account. Allowed by name; anything new fails. */
  const ALLOWED = ["setup-e2e-tenants.mjs"];
  const files = [...filesUnder(authDir, [".ts", ".tsx"]), ...filesUnder(scriptsDir, [".mjs", ".js", ".ts"])]
    .filter((f) => !ALLOWED.some((a) => f.endsWith(a)));

  it("finds the files it is meant to guard", () => {
    expect(files.some((f) => f.endsWith(join("login", "page.tsx")))).toBe(true);
  });

  for (const f of files) {
    it(`${f.slice(root.length + 1)} has no password literal`, () => {
      const hits = readSource(f).split("\n").filter((l) => LITERAL.test(l) && !/process\.env|placeholder|type=/.test(l));
      expect(hits).toEqual([]);
    });
  }
});
