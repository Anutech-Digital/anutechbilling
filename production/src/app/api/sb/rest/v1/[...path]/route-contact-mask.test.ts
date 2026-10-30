/**
 * R-1009: the browser data gateway masks lead / customer phone + email per role — driven through
 * the real route with a real signed session token (DB role lookup and query handler stubbed).
 * Owner and manager get the real values; sales, accountant and the partner agent get masked ones;
 * a masked value sent back in an edit is never written.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const ROLES: Record<string, string> = {};
const handled = vi.fn();

const LEAD = { id: "l1", name: "Ravi", contact_phone: "+91 98765 43210", contact_email: "ravi@shop.in" };

vi.mock("@/server/postgrest/fetch", () => ({ gatewayEnabled: () => true }));
vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (id: { userId: string }, fn: (tx: unknown) => unknown) =>
    fn({ $queryRawUnsafe: async () => [{ role: ROLES[id.userId] ?? null }] }),
}));
vi.mock("@/server/postgrest/handler", () => ({
  handlePostgrest: async (req: { method: string; path: string; body: string | null }) => {
    handled(req);
    const body = req.path === "invoices"
      ? [{ id: "i1", customers: { name: "Shop", contact_email: "ravi@shop.in" } }]
      : [LEAD];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/*" },
    });
  },
}));
vi.mock("@/server/postgrest/catalog", () => ({
  getCatalog: async () => ({
    tables: new Map(["customers", "contacts", "leads", "invoices", "users"].map((n) => [n, {}])),
    fks: [],
    functions: new Map(),
  }),
}));

import { GET, PATCH } from "./route";
import { resetGatewayLimitState } from "@/server/postgrest/gateway-limits";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import { USER_ROLES, can } from "@/lib/auth/roles";

const SECRET = "unit-test-secret-at-least-32-characters!!";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}

/** One user id per role: "<n>…" uuid. */
const USER = Object.fromEntries(USER_ROLES.map((r, i) => [r, `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`]));

async function call(role: string, path: string, query: string, method: "GET" | "PATCH" = "GET", body?: unknown) {
  const req = new NextRequest(`http://localhost/api/sb/rest/v1/${path}?${query}`, {
    method,
    headers: { authorization: `Bearer ${token(USER[role])}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = { params: Promise.resolve({ path: path.split("/") }) };
  return method === "PATCH" ? PATCH(req, ctx) : GET(req, ctx);
}

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.RATE_LIMIT_STORE;
  for (const r of USER_ROLES) ROLES[USER[r]] = r;
  resetGatewayLimitState();
  resetRateLimiter();
  handled.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  vi.restoreAllMocks();
});

describe("R-1009 lead list per role", () => {
  /* R-2125 (GP-10): a personal session never reaches leads at all — 403 before any masking. */
  test("personal: leads refused outright (R-2125 personal allowlist)", async () => {
    const r = await call("personal", "leads", "select=id,name,contact_phone,contact_email");
    expect(r.status).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });
  for (const role of USER_ROLES.filter((r) => r !== "personal")) {
    const sees = can(role, "can_view_contact_details");
    test(`${role}: ${sees ? "real" : "masked"} phone and email`, async () => {
      const r = await call(role, "leads", "select=id,name,contact_phone,contact_email");
      expect(r.status).toBe(200);
      const [row] = await r.json();
      if (sees) {
        expect(row.contact_phone).toBe(LEAD.contact_phone);
        expect(row.contact_email).toBe(LEAD.contact_email);
      } else {
        expect(row.contact_phone).toBe("••••••••3210");
        expect(row.contact_email).toBe("ra•••@shop.in");
        expect(row.name).toBe("Ravi");
      }
    });
  }

  test("owner and manager always see the real values", async () => {
    for (const role of ["owner", "manager"]) {
      const [row] = await (await call(role, "leads", "select=*")).json();
      expect(row.contact_phone).toBe(LEAD.contact_phone);
    }
  });

  test("a customer embedded in an invoice list is masked for sales", async () => {
    const [row] = await (await call("sales", "invoices", "select=id,customers(name,contact_email)")).json();
    expect(row.customers.contact_email).toBe("ra•••@shop.in");
    expect(row.customers.name).toBe("Shop");
  });

  test("the Content-Range header survives masking", async () => {
    const r = await call("sales", "leads", "select=id,contact_phone");
    expect(r.headers.get("content-range")).toBe("0-0/*");
  });
});

describe("R-1009 a masked value is never saved", () => {
  test("sales edits a lead's name: the masked phone in the form is dropped before the write", async () => {
    await call("sales", "leads", "id=eq.l1", "PATCH", { name: "Ravi K", contact_phone: "••••••••3210" });
    const sent = JSON.parse(handled.mock.calls[0][0].body);
    expect(sent).toEqual({ name: "Ravi K" });
  });

  test("sales typing a new real number is saved", async () => {
    await call("sales", "leads", "id=eq.l1", "PATCH", { contact_phone: "9000000001" });
    expect(JSON.parse(handled.mock.calls[0][0].body)).toEqual({ contact_phone: "9000000001" });
  });

  test("owner's body is passed as it is", async () => {
    await call("owner", "leads", "id=eq.l1", "PATCH", { contact_phone: "9000000001" });
    expect(JSON.parse(handled.mock.calls[0][0].body)).toEqual({ contact_phone: "9000000001" });
  });
});
