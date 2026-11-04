/**
 * R-2017 (G-DPDP) — scan: every file under src/app/api/public that holds the service role is in
 * _lib/admin-client-allowlist.ts with its reason, scope and exact table/column/filter use, and
 * reads of personal-data tables are tenant/id/token-filtered and name their columns.
 * The rules are proved red on small made-up routes first, then run on the real folder.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PUBLIC_ADMIN_CLIENT, INFRA_SERVICE_ROLE_LIBS, PII_TABLES, type PublicAdminEntry,
} from "./_lib/admin-client-allowlist";
import { scanPublicAdminClient, USES_SERVICE_ROLE, stripComments } from "./_lib/admin-client-scan";

const PUBLIC = path.resolve(__dirname);
const LIB = path.resolve(__dirname, "../../../lib");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function realFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of walk(PUBLIC)) {
    const rel = path.relative(PUBLIC, f).split(path.sep).join("/");
    if (rel.startsWith("_lib/admin-client-")) continue; // the allowlist + checker themselves
    files[rel] = fs.readFileSync(f, "utf8");
  }
  return files;
}

function libUsesServiceRole(mod: string): boolean {
  for (const cand of [`${mod}.ts`, `${mod}.tsx`, `${mod}/index.ts`]) {
    const p = path.join(LIB, cand);
    if (fs.existsSync(p)) return USES_SERVICE_ROLE.test(stripComments(fs.readFileSync(p, "utf8")));
  }
  return false;
}

const base = { libUsesServiceRole: () => false, infraLibs: INFRA_SERVICE_ROLE_LIBS, piiTables: PII_TABLES };
const entry = (e: Partial<PublicAdminEntry>): PublicAdminEntry =>
  ({ reason: "r", scope: "s", mustContain: [], reads: {}, writes: [], ...e });

describe("R-2017 public admin-client scan — each rule turns red", () => {
  it("a NEW public route with createAdminClient and no entry fails", () => {
    const p = scanPublicAdminClient({ ...base, allowlist: {}, files: {
      "new-thing/route.ts": `import { createAdminClient } from "@/lib/supabase/server";
        export async function GET() { return createAdminClient().from("items").select("name").eq("tenant_id", t); }`,
    } });
    expect(p.join("\n")).toMatch(/new-thing\/route\.ts: uses the service role .*no entry/);
  });

  it("service role through a non-infra lib needs an entry too; infra libs do not", () => {
    const files = { "x/route.ts": `import { a } from "@/lib/checkout/cart-checkout"; import { rateLimit } from "@/lib/security/rate-limit";` };
    const p = scanPublicAdminClient({ ...base, libUsesServiceRole: () => true, allowlist: {}, files });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/via @\/lib\/checkout\/cart-checkout/);
  });

  it("select(*) on a personal-data table, an unlisted column, or a lost tenant filter fails", () => {
    const allowlist = { "a/route.ts": entry({ reads: { leads: { columns: ["id"], by: ["tenant_id"] } } }) };
    const star = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `createAdminClient().from("leads").select("*").eq("tenant_id", t);` } });
    expect(star.join("\n")).toMatch(/select\("\*"\) on personal-data table leads/);
    const extra = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `createAdminClient().from("leads").select("id, contact_phone").eq("tenant_id", t);` } });
    expect(extra.join("\n")).toMatch(/leads\.contact_phone, not in the entry's columns/);
    const noTenant = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `createAdminClient().from("leads").select("id").ilike("contact_email", e);` } });
    expect(noTenant.join("\n")).toMatch(/read of leads lost its "tenant_id" filter/);
    const ok = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `createAdminClient().from("leads").select("id").eq("tenant_id", t);` } });
    expect(ok).toEqual([]);
  });

  it("an unlisted table / write / rpc, a removed guard and a stale entry fail", () => {
    const allowlist = {
      "a/route.ts": entry({ mustContain: ["quoteTokenMatches"], writes: ["quotes"] }),
      "gone/route.ts": entry({}),
    };
    const p = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `createAdminClient().from("customers").select("id").eq("tenant_id", t); admin.rpc("record_payment", {});`,
    } }).join("\n");
    expect(p).toMatch(/reads customers, not listed/);
    expect(p).toMatch(/writes rpc record_payment, not listed/);
    expect(p).toMatch(/guard "quoteTokenMatches"/);
    expect(p).toMatch(/write to quotes the code no longer does/);
    expect(p).toMatch(/gone\/route\.ts: allowlist entry but .*stale/);
  });

  it("a guard mentioned only in a comment does not count", () => {
    const allowlist = { "a/route.ts": entry({ mustContain: ["quoteTokenMatches"] }) };
    const p = scanPublicAdminClient({ ...base, allowlist, files: {
      "a/route.ts": `// quoteTokenMatches used to be here\ncreateAdminClient();` } });
    expect(p.join("\n")).toMatch(/guard "quoteTokenMatches"/);
  });
});

describe("R-2017 public admin-client allowlist — the real src/app/api/public", () => {
  it("every service-role file is listed with its exact tables, columns and filters (none stale)", () => {
    const problems = scanPublicAdminClient({
      files: realFiles(), libUsesServiceRole, allowlist: PUBLIC_ADMIN_CLIENT,
      infraLibs: INFRA_SERVICE_ROLE_LIBS, piiTables: PII_TABLES,
    });
    expect(problems).toEqual([]);
  });

  it("every entry carries a reason and a scope", () => {
    for (const [file, e] of Object.entries(PUBLIC_ADMIN_CLIENT)) {
      expect(e.reason.length, file).toBeGreaterThan(10);
      expect(e.scope.length, file).toBeGreaterThan(10);
    }
  });

  /* The highest-risk ones: anonymous routes that READ customer / lead / employee personal data.
     Each must pin the read to a tenant (or the record the link token names) and name its columns. */
  const PII_READERS: Record<string, { table: string; by: string[] }[]> = {
    "agent/chat/route.ts": [{ table: "leads", by: ["tenant_id"] }],
    "assessment/[token]/route.ts": [{ table: "employees", by: ["tenant_id"] }],
    "trial/hosting/confirm/route.ts": [{ table: "leads", by: ["id", "tenant_id"] }],
    "checkout/support/route.ts": [{ table: "subscriptions", by: ["tenant_id", "customer_id"] }],
    "checkout/workspace/route.ts": [{ table: "tenant_secrets", by: ["tenant_id"] }],
    "checkout/workspace/meta-purchase/route.ts": [{ table: "quotes", by: ["id", "tenant_id"] }],
    "quote/[id]/accept/route.ts": [{ table: "quotes", by: ["id"] }],
    "quote/[id]/pay/route.ts": [{ table: "quotes", by: ["id"] }],
    "quote/[id]/configure/route.ts": [{ table: "quotes", by: ["id"] }],
    "quote/[id]/request-fresh/route.ts": [{ table: "quotes", by: ["id"] }],
    "quote/[id]/upi-notify/route.ts": [{ table: "quotes", by: ["id"] }],
    "project-quote/[id]/accept/route.ts": [{ table: "project_sales", by: ["id"] }],
  };

  it.each(Object.entries(PII_READERS))("%s reads personal data only tenant/token-scoped, named columns", (file, reads) => {
    const e = PUBLIC_ADMIN_CLIENT[file];
    expect(e, file).toBeDefined();
    for (const r of reads) {
      const listed = e.reads[r.table];
      expect(listed, `${file} ${r.table}`).toBeDefined();
      expect(listed.columns).not.toBe("*");
      for (const by of r.by) expect(listed.by).toContain(by);
    }
    // id-only reads are safe only behind the link-token check
    if (reads.some((r) => r.by.length === 1 && r.by[0] === "id")) expect(e.mustContain).toContain("quoteTokenMatches");
    // the scan above already checks the code matches the entry; re-run it for this file alone
    const src = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    expect(scanPublicAdminClient({
      files: { [file]: src }, libUsesServiceRole, allowlist: { [file]: e },
      infraLibs: INFRA_SERVICE_ROLE_LIBS, piiTables: PII_TABLES,
    })).toEqual([]);
  });

  it("no PII reader returns the tenant's Razorpay keys or a lead's contact details in its JSON", () => {
    const code = stripComments(fs.readFileSync(path.join(PUBLIC, "checkout/workspace/route.ts"), "utf8"));
    expect(code).not.toMatch(/NextResponse\.json\([^)]*razorpay_key_secret/);
    const confirm = stripComments(fs.readFileSync(path.join(PUBLIC, "trial/hosting/confirm/route.ts"), "utf8"));
    expect(confirm).not.toMatch(/NextResponse\.json\(/); // redirects only
  });
});
