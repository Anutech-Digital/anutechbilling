/**
 * MCP code never reaches the service role: no createAdminClient / createAdminClientFor, no
 * SUPABASE_SERVICE_ROLE_KEY, no "service_role", no @/lib/supabase/bare, in any file under
 * src/lib/mcp, src/app/api/mcp, src/app/.well-known or the consent page. Every DB call goes
 * through McpDb (src/lib/mcp/db.ts) with the caller's own JWT. And nothing here imports a
 * file from the Billing & Subscriptions section except the read-only invoice helpers.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const DIRS = ["src/lib/mcp", "src/app/api/mcp", "src/app/.well-known", "src/app/(auth)/mcp"];

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return files(rel);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

const ALL = DIRS.flatMap(files);

describe("MCP guard", () => {
  it("finds the MCP source files", () => {
    expect(ALL.length).toBeGreaterThan(15);
  });

  it.each(ALL)("%s never names the service role", (f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    expect(src).not.toMatch(/createAdminClient|createAdminClientFor|SUPABASE_SERVICE_ROLE_KEY|service_role|@\/lib\/supabase\/bare/);
  });

  it.each(ALL)("%s imports nothing from the billing section except the reviewed read-only helpers", (f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const imports = [...src.matchAll(/from\s+"(@\/[^"]+)"/g)].map((m) => m[1]);
    const billing = imports.filter((i) => /^@\/(lib\/(quotes|subscriptions|invoices|renewals)|app\/\(app\)\/(customers|quotes|subscriptions|renewals|invoices|payments|projects)|components\/features\/(customers|quotes|subscriptions|invoices|projects))(\/|$)/.test(i));
    expect(billing.filter((i) => i !== "@/lib/invoices/kpis" && i !== "@/lib/invoices/overdue")).toEqual([]);
  });

  it("builds no Supabase client of its own — only the per-user one from lib/supabase/as-user", () => {
    for (const f of ALL) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*"@supabase\/supabase-js"/);
    }
    expect(fs.readFileSync(path.join(ROOT, "src/lib/mcp/db.ts"), "utf8")).toContain("createClientAsUser(");
  });
});
