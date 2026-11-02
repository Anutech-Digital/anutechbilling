/**
 * R-2360 — POST /api/integrations/zoho-books/payment-matches (Banking "Zoho has a match"):
 * owner/accountant only, the caller's own tenant's unmatched money-in lines, one cached batch read
 * of Zoho, nothing written. Zoho is a fake fetch; the connection store is mocked; values are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT = "11111111-0000-4000-8000-00000000e1ce";
const ACCOUNT = "55555555-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  conn: { refreshToken: "rt" as string | null, orgId: "600" as string | null, orgName: "Org", connectedAt: null },
  rows: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, string, unknown]>,
  writes: 0,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : {
    userId: "u1", tenantId: TENANT, role: st.role, canManage: true,
    admin: {
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (k: string, v: unknown) => { st.filters.push(["eq", k, v]); return q; },
          is: (k: string, v: unknown) => { st.filters.push(["is", k, v]); return q; },
          gt: (k: string, v: unknown) => { st.filters.push(["gt", k, v]); return q; },
          order: () => q,
          range: async () => ({ data: st.rows, error: null }),
          update: () => { st.writes += 1; return q; },
          insert: () => { st.writes += 1; return q; },
        };
        return q;
      },
    },
  }),
  readConnection: async () => st.conn,
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));

import { POST } from "./route";
import { clearZohoBatchCache } from "@/lib/integrations/zoho-books/payment-batch";

const zohoCalls: string[] = [];
function fakeFetch(input: string | URL | Request) {
  const url = new URL(String(input));
  zohoCalls.push(url.toString());
  return Promise.resolve(new Response(JSON.stringify({
    code: 0,
    customerpayments: [{ payment_id: "p1", payment_number: "7801", date: "2026-07-21", amount: 27081, reference_number: "IDFB6202M2890149", customer_id: "c1", customer_name: "SUPREME" }],
    page_context: { has_more_page: false },
  }), { status: 200 }));
}

const req = (body: unknown) => new NextRequest("http://localhost:3001/api/integrations/zoho-books/payment-matches", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  clearZohoBatchCache();
  st.role = "owner";
  st.conn = { refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null };
  st.rows = [
    { id: "l1", txn_date: "2026-07-21", credit: 27081, reference: null, description: "NEFT CR-IDFB0080202-SUPREME MEDIA-IDFB6202M2890149" },
    { id: "l2", txn_date: "2026-07-21", credit: 999, reference: null, description: "UPI SOMEONE" },
  ];
  st.filters = []; st.writes = 0; zohoCalls.length = 0;
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "test-id");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("R-2360 payment-matches route", () => {
  it("owner: counts the lines with a Zoho payment; own tenant + account, unmatched money-in only; writes nothing", async () => {
    const res = await POST(req({ accountId: ACCOUNT }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toMatchObject({ txnIds: ["l1"], lines: 2, payments: 1, complete: true });
    expect(st.filters).toEqual(expect.arrayContaining([
      ["eq", "tenant_id", TENANT], ["eq", "bank_account_id", ACCOUNT], ["is", "matched_to_type", null], ["gt", "credit", 0],
    ]));
    expect(st.writes).toBe(0);
    expect(zohoCalls).toHaveLength(1);
  });

  it("opening Banking again within 30 min does not ask Zoho again", async () => {
    await POST(req({ accountId: ACCOUNT }));
    await POST(req({ accountId: ACCOUNT }));
    expect(zohoCalls).toHaveLength(1);
  });

  it("manager / sales → 403; Zoho not connected → 409 not_connected; Zoho never asked", async () => {
    for (const role of ["manager", "sales"]) {
      st.role = role;
      expect((await POST(req({ accountId: ACCOUNT }))).status).toBe(403);
    }
    st.role = "accountant";
    st.conn = { ...st.conn, refreshToken: null };
    const res = await POST(req({ accountId: ACCOUNT }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_connected");
    expect(zohoCalls).toHaveLength(0);
  });

  it("no account id → 400", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });
});
