/**
 * R-1005: the data gateway's per-user limits for low roles, driven through the real route with
 * a real signed session token. The database (role lookup) and the query handler are stubbed —
 * the handler answers `limit` rows (default 50) with a PostgREST Content-Range.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const ROLES: Record<string, string> = {};
const handled = vi.fn();

vi.mock("@/server/postgrest/fetch", () => ({ gatewayEnabled: () => true }));
vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (id: { userId: string }, fn: (tx: unknown) => unknown) =>
    fn({ $queryRawUnsafe: async () => [{ role: ROLES[id.userId] ?? null }] }),
}));
vi.mock("@/server/postgrest/handler", () => ({
  handlePostgrest: async (req: { search: URLSearchParams; method: string; path: string }) => {
    handled(req);
    const n = Math.min(Number(req.search.get("limit") ?? 50), 1000);
    const off = Number(req.search.get("offset") ?? 0);
    /* R-1400: "quotes" rows carry 99 embedded payments each, plus a to-one customer. */
    const row = (i: number) => req.path === "quotes"
      ? { id: i, payments: Array.from({ length: 99 }, (_, k) => ({ id: k })), customer: { name: "x" } }
      : { id: i };
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => row(i))), {
      status: 200, headers: { "Content-Type": "application/json", "Content-Range": `${off}-${off + n - 1}/*` },
    });
  },
}));

/* R-1400: a tiny catalog so FK-column embeds (customer_id(*)) resolve to their table. */
vi.mock("@/server/postgrest/catalog", () => ({
  getCatalog: async () => ({
    tables: new Map(["customers", "contacts", "payments", "invoices", "quotes", "leads", "users"].map((n) => [n, {}])),
    fks: [
      { name: "invoices_customer_id_fkey", table: "invoices", columns: ["customer_id"], refTable: "customers", refColumns: ["id"] },
      { name: "invoices_created_by_fkey", table: "invoices", columns: ["created_by"], refTable: "users", refColumns: ["id"] },
      { name: "quotes_lead_id_fkey", table: "quotes", columns: ["lead_id"], refTable: "leads", refColumns: ["id"] },
    ],
    functions: new Map(),
  }),
}));

import { GET, HEAD } from "./route";
import { resetGatewayLimitState } from "@/server/postgrest/gateway-limits";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import { GATEWAY_LIMITED_BY_ROLE, USER_ROLES } from "@/lib/auth/roles";

const SECRET = "unit-test-secret-at-least-32-characters!!";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}

const SALES = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const DELIVERY = "33333333-3333-4333-8333-333333333333";
const NOROW = "44444444-4444-4444-8444-444444444444";

async function call(user: string, path: string, query = "", method: "GET" | "HEAD" = "GET") {
  const req = new NextRequest(`http://localhost/api/sb/rest/v1/${path}${query ? `?${query}` : ""}`, {
    method, headers: { authorization: `Bearer ${token(user)}` },
  });
  const ctx = { params: Promise.resolve({ path: path.split("/") }) };
  return method === "HEAD" ? HEAD(req, ctx) : GET(req, ctx);
}

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.RATE_LIMIT_STORE;
  Object.assign(ROLES, { [SALES]: "sales", [OWNER]: "owner", [DELIVERY]: "delivery" });
  resetGatewayLimitState();
  resetRateLimiter();
  handled.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  vi.restoreAllMocks();
});

describe("R-1005 role table", () => {
  test("every role is decided; exactly the six low roles are limited", () => {
    expect(Object.keys(GATEWAY_LIMITED_BY_ROLE).sort()).toEqual([...USER_ROLES].sort());
    /* R-1791 (23 Oct 2026): the Marketing role is limited too — it reads no customer data.
       R-2110 (30 Oct 2026): so is the personal role (free accounts are the many-user case). */
    expect(USER_ROLES.filter((r) => GATEWAY_LIMITED_BY_ROLE[r]).sort())
      .toEqual(["delivery", "marketing", "partner_agent", "personal", "sales", "sales_senior", "support"]);
  });
});

describe("R-1005 normal calls pass", () => {
  test("a low role's list with named columns and a normal page goes through", async () => {
    const r = await call(SALES, "customers", "select=id,name&order=name.asc&offset=0&limit=50");
    expect(r.status).toBe(200);
    expect(handled).toHaveBeenCalledTimes(1);
  });
  test("select=* on a table that is not customers/contacts/payments is fine", async () => {
    expect((await call(SALES, "leads", "select=*")).status).toBe(200);
  });
  test("HEAD count with select=* on customers is fine (no rows leave)", async () => {
    expect((await call(SALES, "customers", "select=*", "HEAD")).status).toBe(200);
  });
});

describe("R-1005 select=* block", () => {
  for (const table of ["customers", "contacts", "payments"]) {
    test(`low role refused select=* on ${table}`, async () => {
      const r = await call(SALES, table, "select=*");
      expect(r.status).toBe(400);
      const body = await r.json();
      expect(body.code).toBe("ROS_SELECT_STAR");
      expect(body.message).toMatch(/Ask for the columns you need by name/);
      expect(handled).not.toHaveBeenCalled();
    });
  }
  test("no select at all means * — refused too", async () => {
    expect((await call(DELIVERY, "payments")).status).toBe(400);
  });
  test("embedded customers(*) through another table — refused", async () => {
    expect((await call(SALES, "invoices", "select=id,customers(*)")).status).toBe(400);
    expect((await call(SALES, "customer_contacts", "select=role,contacts(*)")).status).toBe(400);
  });
  test("refusal is logged", async () => {
    await call(SALES, "customers", "select=*");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("\"event\":\"gateway_refused\""));
  });
});

describe("R-1005 paging caps", () => {
  test("offset past 5000 refused; 5000 allowed", async () => {
    expect((await call(SALES, "leads", "select=id&offset=5000")).status).toBe(200);
    const r = await call(SALES, "leads", "select=id&offset=5001");
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("ROS_OFFSET");
  });
  test("embedded offset is capped too", async () => {
    expect((await call(SALES, "customers", "select=id,invoices(id)&invoices.offset=9000")).status).toBe(400);
  });
  test("limit over 1000 refused", async () => {
    const r = await call(SALES, "leads", "select=id&limit=5000");
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("ROS_LIMIT");
  });
});

describe("R-1005 rate limit", () => {
  test("301st request in a minute is a 429 with Retry-After", async () => {
    for (let i = 0; i < 300; i++) expect((await call(SALES, "leads", "select=id&limit=1")).status).toBe(200);
    const r = await call(SALES, "leads", "select=id&limit=1");
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBeTruthy();
    expect((await r.json()).message).toMatch(/Too many requests/);
  });
});

describe("R-1005 daily row budget", () => {
  test("once 20,000 rows are read today, the next read is refused", async () => {
    // 20 reads × 1000 rows = 20,000
    for (let i = 0; i < 20; i++) {
      expect((await call(SALES, "leads", `select=id&limit=1000&offset=${(i % 5) * 1000}`)).status).toBe(200);
    }
    const r = await call(SALES, "leads", "select=id&limit=10");
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.code).toBe("ROS_DAILY_ROWS");
    expect(body.message).toMatch(/today's limit of 20,000 records/);
    // another low-role user has their own budget
    expect((await call(DELIVERY, "leads", "select=id&limit=10")).status).toBe(200);
  });
});

describe("R-1005 owner is not limited", () => {
  test("owner: select=*, deep offset, big limit, 400 calls and 25k rows — all pass", async () => {
    expect((await call(OWNER, "customers", "select=*")).status).toBe(200);
    expect((await call(OWNER, "payments", "offset=50000")).status).toBe(200);
    expect((await call(OWNER, "leads", "select=id&limit=5000")).status).toBe(200);
    for (let i = 0; i < 400; i++) expect((await call(OWNER, "leads", "select=id&limit=100")).status).toBe(200);
  });
  test("a user with no users row counts as limited (fail closed)", async () => {
    expect((await call(NOROW, "customers", "select=*")).status).toBe(400);
  });
});

describe("R-1400 FK-column embeds meet the star block", () => {
  test("customer_id(*) on invoices resolves to customers — refused", async () => {
    const r = await call(SALES, "invoices", "select=id,customer_id(*)");
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/all columns of customers/);
    expect(handled).not.toHaveBeenCalled();
  });
  test("aliased and nested FK-column embeds — refused", async () => {
    expect((await call(SALES, "invoices", "select=id,c:customer_id(*)")).status).toBe(400);
    expect((await call(DELIVERY, "quotes", "select=id,lead_id(id,contact_id(*))")).status).toBe(400);
    expect((await call(SALES, "invoices", "select=id,payment_id(*)")).status).toBe(400);
  });
  test("named columns through an FK-column embed, and FK embeds to other tables — pass", async () => {
    expect((await call(SALES, "invoices", "select=id,customer_id(name)")).status).toBe(200);
    expect((await call(SALES, "invoices", "select=id,created_by(*)")).status).toBe(200);
    expect((await call(SALES, "quotes", "select=id,lead_id(*)")).status).toBe(200);
  });
  test("owner may still embed customer_id(*)", async () => {
    expect((await call(OWNER, "invoices", "select=id,customer_id(*)")).status).toBe(200);
  });
});

describe("R-1400 embedded child rows count in the daily budget", () => {
  test("200 quotes × (99 payments + 1 customer) = 20,200 rows — the next read is refused", async () => {
    const q = "select=id,payments(id),customer:customers(name)&limit=100";
    expect((await call(SALES, "quotes", q)).status).toBe(200); // 100 + 9,900 + 100 = 10,100
    expect((await call(SALES, "quotes", q)).status).toBe(200); // 20,200
    const r = await call(SALES, "leads", "select=id&limit=1");
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe("ROS_DAILY_ROWS");
  });
  test("without embeds only the top-level rows count", async () => {
    expect((await call(SALES, "quotes", "select=id&limit=1000")).status).toBe(200);
    expect((await call(SALES, "leads", "select=id&limit=1")).status).toBe(200);
  });
});
