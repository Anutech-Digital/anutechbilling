/**
 * R-2876: public.renewal_row_facts answers with row lists inside ONE JSON object. A scalar RPC answer has no
 * Content-Range, so the R-1005 daily row budget of a limited role would count it as 0 rows — while the table reads it
 * replaces (quotes, invoices, payments …) were charged row by row. The route now counts the rows inside the answer.
 * Driven through the real route with a real signed session token; the database (role lookup) and the query handler are
 * stubbed, as in route.test.ts.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const ROLES: Record<string, string> = {};
/** What the stubbed handler answers for rpc/renewal_row_facts. */
const FACTS = {
  quotes: Array.from({ length: 40 }, (_, i) => ({ id: `Q${i}` })),
  billings: Array.from({ length: 10 }, (_, i) => ({ id: `B${i}` })),
  links: [{ id: 1 }],
  invoices: Array.from({ length: 30 }, (_, i) => ({ id: `I${i}` })),
  credit_notes: [{ id: "CN1" }],
  debit_notes: [],
  subscriptions: Array.from({ length: 5 }, (_, i) => ({ id: `S${i}` })),
  payments: Array.from({ length: 13 }, (_, i) => ({ id: `P${i}` })),
  invoice_ids: Array.from({ length: 30 }, (_, i) => `I${i}`),   // ids only — not rows, not counted
};
const ROWS = 40 + 10 + 1 + 30 + 1 + 0 + 5 + 13;

vi.mock("@/server/postgrest/fetch", () => ({ gatewayEnabled: () => true }));
vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (id: { userId: string }, fn: (tx: unknown) => unknown) =>
    fn({ $queryRawUnsafe: async () => [{ role: ROLES[id.userId] ?? null }] }),
}));
vi.mock("@/server/postgrest/handler", () => ({
  handlePostgrest: async (req: { path: string }) => {
    const body = req.path === "rpc/renewal_row_facts" ? FACTS : req.path === "rpc/nav_badges" ? { renewals: 7, quotes: [1, 2, 3] } : [];
    /* a scalar answer: no row range (handler.ts answers "*\/*") */
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "*/*" } });
  },
}));
vi.mock("@/server/postgrest/catalog", () => ({ getCatalog: async () => ({ tables: new Map(), fks: [], functions: new Map() }) }));

import { POST } from "./route";
import { addGatewayRows, isRowListRpc, resetGatewayLimitState, rpcRowsInBody, RPC_ROW_LISTS } from "@/server/postgrest/gateway-limits";
import { resetRateLimiter } from "@/lib/security/rate-limit";

const SECRET = "unit-test-secret-at-least-32-characters!!";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}
const SALES = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

async function rpc(user: string, name: string) {
  const req = new NextRequest(`http://localhost/api/sb/rest/v1/rpc/${name}`, {
    method: "POST", headers: { authorization: `Bearer ${token(user)}`, "content-type": "application/json" },
    body: JSON.stringify({ p_sub_ids: ["11111111-1111-4111-8111-1111111111aa"], p_quote_ids: [] }),
  });
  return POST(req, { params: Promise.resolve({ path: ["rpc", name] }) });
}

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.RATE_LIMIT_STORE;
  Object.assign(ROLES, { [SALES]: "sales", [OWNER]: "owner" });
  resetGatewayLimitState();
  resetRateLimiter();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  vi.restoreAllMocks();
});

describe("R-2876 the row budget counts the rows inside renewal_row_facts' answer", () => {
  test("a limited role (sales): every row in every list is charged", async () => {
    const r = await rpc(SALES, "renewal_row_facts");
    expect(r.status).toBe(200);
    expect((await r.json()).quotes).toHaveLength(40);
    expect(await addGatewayRows(SALES, 0)).toBe(ROWS);
    await rpc(SALES, "renewal_row_facts");
    expect(await addGatewayRows(SALES, 0)).toBe(2 * ROWS);
  });

  test("another scalar RPC (nav_badges) is charged nothing, as before — even when its answer holds a list", async () => {
    await rpc(SALES, "nav_badges");
    expect(await addGatewayRows(SALES, 0)).toBe(0);
  });

  test("an unlimited role (owner) is not counted at all", async () => {
    await rpc(OWNER, "renewal_row_facts");
    expect(await addGatewayRows(OWNER, 0)).toBe(0);
  });

  test("the counter: only the listed row lists, never ids; unreadable bodies count 0", () => {
    expect(isRowListRpc("rpc/renewal_row_facts")).toBe(true);
    expect(isRowListRpc("renewal_row_facts")).toBe(false);
    expect(isRowListRpc("rpc/toString")).toBe(false);
    expect(rpcRowsInBody("rpc/renewal_row_facts", JSON.stringify(FACTS))).toBe(ROWS);
    expect(rpcRowsInBody("rpc/renewal_row_facts", "not json")).toBe(0);
    expect(rpcRowsInBody("rpc/renewal_row_facts", "[1,2,3]")).toBe(0);
    expect(rpcRowsInBody("rpc/nav_badges", JSON.stringify(FACTS))).toBe(0);
    expect(RPC_ROW_LISTS.renewal_row_facts).not.toContain("invoice_ids");
  });

  test("every row list the function returns is on the counter's list (a new list must be added there too)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261116215511_r2876_renewal_row_facts.sql", "utf8").split("select jsonb_build_object(")[1];
    const keys = [...sql.matchAll(/^\s{4}'([a-z_]+)', coalesce\(/gm)].map((m) => m[1]);
    expect(keys).toHaveLength(9);
    expect(keys.filter((k) => k !== "invoice_ids").sort()).toEqual([...RPC_ROW_LISTS.renewal_row_facts].sort());
  });
});
