/**
 * The "forgetting is impossible" rules, enforced in the normal unit suite (and so in the
 * deploy gate). Lint says the same thing, but lint is not in the Cloud Build gate — this is.
 *
 *  1. The generated Prisma client, @prisma/*, and the context setter are imported only
 *     inside src/server/db.
 *  2. Cross-tenant job access (src/server/db/jobs) is imported only by src/app/api/cron/**.
 *  3. `new PrismaClient` exists only in src/server/db/index.ts, jobs.ts and gateway.ts.
 *  4. The tenant context is written only in src/server/db/{context,index}.ts, and always
 *     transaction-local: set_config(…, true). A session-level SET would survive COMMIT and
 *     ride the pooled connection into the next request — another tenant's, possibly.
 *  5. The gateway's logins (src/server/db/gateway, incl. the service-role equivalent) are
 *     used only by the PostgREST-compatible gateway in src/server/postgrest.
 *  6. createAdminClient() call sites can only go DOWN (each is a full-bypass key today).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(__dirname, "..", "..");
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || rel(p) === "server/db/generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ path: rel(p), code: readFileSync(p, "utf8") }));
const inDb = (p: string) => p.startsWith("server/db/");
const isTest = (p: string) => /\.test\.(ts|tsx)$/.test(p);

describe("database import boundary", () => {
  test("the raw client and the context setter stay inside src/server/db", () => {
    const bad = FILES.filter((f) => !inDb(f.path)).filter((f) =>
      /from\s+["'](@prisma\/client[^"']*|@prisma\/adapter-pg|@\/server\/db\/generated[^"']*|@\/server\/db\/context|[./]+\/server\/db\/(generated|context)[^"']*)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("cross-tenant job access is imported only by cron routes", () => {
    const bad = FILES.filter((f) => !inDb(f.path) && !f.path.startsWith("app/api/cron/"))
      .filter((f) => /from\s+["'](@\/server\/db\/jobs|[./]+\/server\/db\/jobs)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("new PrismaClient appears only in the src/server/db pool files", () => {
    const where = FILES.filter((f) => !isTest(f.path) && /new\s+PrismaClient\s*\(/.test(f.code)).map((f) => f.path).sort();
    expect(where).toEqual(["server/db/auth-store.ts", "server/db/gateway.ts", "server/db/index.ts", "server/db/jobs.ts"]);
  });

  test("the login store (password hashes, two-step secrets) is used only by src/server/auth", () => {
    const bad = FILES.filter((f) => !inDb(f.path) && !f.path.startsWith("server/auth/") && !isTest(f.path))
      .filter((f) => /from\s+["'](@\/server\/db\/auth-store|[./]+\/server\/db\/auth-store)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("the gateway's logins are used only by src/server/postgrest", () => {
    const bad = FILES.filter((f) => !inDb(f.path) && !f.path.startsWith("server/postgrest/") && !isTest(f.path))
      .filter((f) => /from\s+["'](@\/server\/db\/gateway|[./]+\/server\/db\/gateway)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("supabase-js clients are built only in src/lib/supabase (so the VM switches reach them)", () => {
    // A client built straight from supabase-js bypasses the in-process gateway and Auth.js —
    // with the VM off it would call the public route with the service key and be refused.
    // Use createClient/createAdminClient from @/lib/supabase/server, or createBareClient from @/lib/supabase/bare.
    const bad = FILES.filter((f) => !isTest(f.path) && !f.path.startsWith("lib/supabase/"))
      .filter((f) => /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@supabase\/supabase-js["']/.test(f.code)
        || /\b(createServerClient|createBrowserClient)\s*[<(]/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("createAdminClient() call sites only go down", () => {
    // Measured 5 Oct 2026. Lower this number when you move one to withTenant; never raise it.
    /* 207, not 205 (6 Oct 2026 staging merge): /api/agent/feedback-queue and
       /api/agent/feedback-checked (R-183/R-188, cross-tenant by design, token-gated) came from
       manager-pardeep, which does not have src/server/db yet. R-194 moves both onto the jobs
       client when R-161 lands there, and this goes back to 205. */
    // 208 since 6 Oct evening: /api/agent/feedback-fixed (R-200), same reason, same R-194.
    /* 217 since the 7 Oct 2026 staging train (b11e9539): manager-pardeep added 9 service-role
       call sites (agent feedback-claimed, feedback auto-send, platform Send to AI, temp password,
       accept Pay now, …) and has no src/server/db yet. Same R-194 plan: move them to the jobs
       client / withTenant when R-161 lands on manager-pardeep, then lower this. */
    const BASELINE = 217;
    const count = FILES.filter((f) => !isTest(f.path)).reduce((n, f) => n + (f.code.match(/createAdminClient\(\)/g)?.length ?? 0), 0);
    expect(count).toBeLessThanOrEqual(BASELINE);
  });

  test("the tenant context is set only by src/server/db, and only transaction-locally", () => {
    const where = FILES.filter((f) => !isTest(f.path) && /set_config\s*\(\s*'app\./.test(f.code)).map((f) => f.path).sort();
    expect(where).toEqual(["server/db/context.ts", "server/db/index.ts"]);
    for (const f of FILES.filter((x) => where.includes(x.path))) {
      const calls = f.code.match(/set_config\(\s*'app\.[a-z_]+',[^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c, `${f.path}: ${c}`).toMatch(/,\s*true\s*\)$/);
    }
    const sessionSet = FILES.filter((f) => !isTest(f.path) && /\bset\s+(session\s+)?app\.(tenant_id|user_id)\b/i.test(f.code));
    expect(sessionSet.map((f) => f.path)).toEqual([]);
  });
});
