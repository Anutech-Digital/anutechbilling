/**
 * R-1555 — inbound mail routes must NOT fall back to the hard-coded Anutech tenant on a
 * deployed server. With INBOUND_EMAIL_TENANT_ID and BUY_PAGE_TENANT_ID both missing:
 *   - a production deployment answers 503 and writes NOTHING;
 *   - a laptop (`next dev`) keeps the old dev tenant, so the local demo still works.
 * Covered routes: webhooks/inbound-purchase, webhooks/inbound-email (lib/inbound/ingest.ts),
 * v1/integrations/support-email-inbound.
 *
 * No DB: createAdminClient is a stand-in that records inserts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ inserts: [] as { table: string; row: Record<string, unknown> }[] }));

vi.mock("@/lib/supabase/server", () => {
  function query(table: string) {
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, in: () => q, ilike: () => q, or: () => q, neq: () => q, is: () => q,
      order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: { message: "stub" } }),
      insert: (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        /* Pretend the claim is a duplicate so the route stops right after deciding the tenant. */
        const res = { data: null, error: { code: "23505", message: "duplicate key" } };
        return { ...res, select: () => ({ single: async () => res, maybeSingle: async () => res }), then: (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok) };
      },
      update: () => q,
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
    };
    return q;
  }
  const client = { from: (t: string) => query(t), rpc: async () => ({ data: null, error: null }) };
  return { createAdminClient: () => client, createAdminClientFor: () => client, createClient: () => client };
});

/* Each test re-imports a route (resetModules), and inbound-email pulls in the whole AI sales
   pipeline — the first import alone can pass 5 s on a busy machine. */
vi.setConfig({ testTimeout: 60_000 });

const SECRET = "inbound_aitest_secret";
const DEV_TENANT = "fbb976f1-9090-4f10-9726-0901bd144e42";
const ENV_KEYS = ["INBOUND_EMAIL_TENANT_ID", "BUY_PAGE_TENANT_ID", "NEXT_PUBLIC_APP_ENV", "K_SERVICE"];

const ROUTES = [
  ["webhooks/inbound-purchase", () => import("./inbound-purchase/route"), "http://localhost/api/webhooks/inbound-purchase"],
  ["webhooks/inbound-email", () => import("./inbound-email/route"), "http://localhost/api/webhooks/inbound-email"],
  ["v1/integrations/support-email-inbound", () => import("../v1/integrations/support-email-inbound/route"), "http://localhost/api/v1/integrations/support-email-inbound"],
] as const;

const mail = (url: string) => new NextRequest(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-inbound-secret": SECRET },
  body: JSON.stringify({ from: "Buyer <buyer@example.in>", to: "sales@example.in", subject: "Order #123", text: "hello", messageId: "m-aitest-1" }),
});

beforeEach(() => {
  vi.resetModules();
  db.inserts = [];
  vi.stubEnv("INBOUND_EMAIL_SECRET", SECRET);
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(ROUTES)("%s — tenant env missing", (_name, load, url) => {
  it("production deployment → 503, nothing written, never the Anutech tenant", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { POST } = await load();
    const res = await POST(mail(url));
    expect(res.status).toBe(503);
    expect(db.inserts).toHaveLength(0);
  });

  it("Cloud Run (K_SERVICE) counts as a deployment too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("K_SERVICE", "resellersos-staging");
    const { POST } = await load();
    expect((await POST(mail(url))).status).toBe(503);
    expect(db.inserts).toHaveLength(0);
  });

  it("laptop (next dev) keeps the dev tenant for the local demo", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { POST } = await load();
    const res = await POST(mail(url));
    expect(res.status).not.toBe(503);
    expect(db.inserts[0]?.row.tenant_id).toBe(DEV_TENANT);
  });

  it("env set → that tenant, even in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INBOUND_EMAIL_TENANT_ID", "99999999-9999-4999-8999-999999999999");
    const { POST } = await load();
    const res = await POST(mail(url));
    expect(res.status).not.toBe(503);
    expect(db.inserts[0]?.row.tenant_id).toBe("99999999-9999-4999-8999-999999999999");
  });
});
