/**
 * R-2125 (GP-10): personal sessions reach only the personal allowlist through the data gateway.
 * Driven through the real route with a real signed session token; the role/workspace lookup and
 * the query handler are stubbed (same harness as route.test.ts).
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const WHO: Record<string, { role: string | null; workspace_kind: string | null }> = {};
const lookups = vi.fn();
const handled = vi.fn();

vi.mock("@/server/postgrest/fetch", () => ({ gatewayEnabled: () => true }));
vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (id: { userId: string }, fn: (tx: unknown) => unknown) =>
    fn({
      $queryRawUnsafe: async () => {
        lookups(id.userId);
        const w = WHO[id.userId];
        return w ? [{ role: w.role, workspace_kind: w.workspace_kind }] : [];
      },
    }),
}));
vi.mock("@/server/postgrest/handler", () => ({
  handlePostgrest: async (req: { path: string }) => {
    handled(req.path);
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "*/0" } });
  },
}));
vi.mock("@/server/postgrest/catalog", () => ({
  getCatalog: async () => ({ tables: new Map(), fks: [], functions: new Map() }),
}));

import { GET, POST } from "./route";
import { gatewayRole, invalidateGatewayRole, resetGatewayLimitState } from "@/server/postgrest/gateway-limits";
import { resetRateLimiter } from "@/lib/security/rate-limit";

const SECRET = "unit-test-secret-at-least-32-characters!!";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}

const PERSONAL = "55555555-5555-4555-8555-555555555555";
const OWNER = "22222222-2222-4222-8222-222222222222";
const SALES = "11111111-1111-4111-8111-111111111111";
/* An owner whose workspace the platform marked personal (mid-migration / mis-set): the kind wins. */
const KIND_ONLY = "66666666-6666-4666-8666-666666666666";

async function call(user: string, method: "GET" | "POST", path: string, query = "") {
  const req = new NextRequest(`http://localhost/api/sb/rest/v1/${path}${query ? `?${query}` : ""}`, {
    method, headers: { authorization: `Bearer ${token(user)}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const ctx = { params: Promise.resolve({ path: path.split("/") }) };
  return method === "POST" ? POST(req, ctx) : GET(req, ctx);
}

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.RATE_LIMIT_STORE;
  Object.assign(WHO, {
    [PERSONAL]: { role: "personal", workspace_kind: "personal" },
    [OWNER]: { role: "owner", workspace_kind: "business" },
    [SALES]: { role: "sales", workspace_kind: "business" },
    [KIND_ONLY]: { role: "owner", workspace_kind: "personal" },
  });
  resetGatewayLimitState();
  resetRateLimiter();
  handled.mockClear();
  lookups.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  vi.restoreAllMocks();
});

describe("R-2125 personal caller through the gateway", () => {
  test("rpc/generate_invoice and rpc/record_payment → 403, logged, never reach the database", async () => {
    for (const fn of ["generate_invoice", "record_payment"]) {
      const r = await call(PERSONAL, "POST", `rpc/${fn}`);
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe("ROS_PERSONAL");
    }
    expect(handled).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("\"event\":\"gateway_refused\""));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("\"reason\":\"personal\""));
  });
  test("tenants?select=*,customers(*) → 403", async () => {
    expect((await call(PERSONAL, "GET", "tenants", "select=*,customers(*)")).status).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });
  test("personal_transactions and personal_accounts → 200", async () => {
    expect((await call(PERSONAL, "GET", "personal_transactions", "select=*")).status).toBe(200);
    expect((await call(PERSONAL, "GET", "personal_accounts", "select=*")).status).toBe(200);
    expect(handled).toHaveBeenCalledTimes(2);
  });
  test("workspace_kind personal is enough — even with a business role on the row", async () => {
    expect((await call(KIND_ONLY, "POST", "rpc/generate_invoice")).status).toBe(403);
    expect((await call(KIND_ONLY, "GET", "customers", "select=id")).status).toBe(403);
  });
});

describe("R-2125 business callers unchanged", () => {
  test("owner reaches business tables and RPCs", async () => {
    expect((await call(OWNER, "POST", "rpc/generate_invoice")).status).toBe(200);
    expect((await call(OWNER, "GET", "tenants", "select=*,customers(*)")).status).toBe(200);
  });
  test("sales keeps its R-1005 limits (select=* on customers is the R-1005 400, not a 403)", async () => {
    expect((await call(SALES, "GET", "customers", "select=id,name")).status).toBe(200);
    expect((await call(SALES, "GET", "customers", "select=*")).status).toBe(400);
  });
});

describe("R-2125 gatewayRole cache", () => {
  test("returns role and workspace kind; cached for a minute", async () => {
    expect(await gatewayRole(PERSONAL)).toEqual({ role: "personal", workspaceKind: "personal" });
    await gatewayRole(PERSONAL);
    expect(lookups).toHaveBeenCalledTimes(1);
  });
  test("invalidateGatewayRole forces a fresh read (upgrade personal → business takes effect at once)", async () => {
    await gatewayRole(PERSONAL);
    WHO[PERSONAL] = { role: "owner", workspace_kind: "business" };
    expect((await gatewayRole(PERSONAL)).workspaceKind).toBe("personal"); // still cached
    invalidateGatewayRole(PERSONAL);
    expect(await gatewayRole(PERSONAL)).toEqual({ role: "owner", workspaceKind: "business" });
    expect(lookups).toHaveBeenCalledTimes(2);
    expect((await call(PERSONAL, "POST", "rpc/generate_invoice")).status).toBe(200);
  });
  test("no row → role and kind null (treated as limited, not personal)", async () => {
    expect(await gatewayRole("77777777-7777-4777-8777-777777777777")).toEqual({ role: null, workspaceKind: null });
  });
});
