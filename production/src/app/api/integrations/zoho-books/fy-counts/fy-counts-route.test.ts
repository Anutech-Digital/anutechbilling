/**
 * R-2498 — POST /api/integrations/zoho-books/fy-counts: "Count FY 2025-26" on the Zoho Books card.
 * Owner / manager / accountant; the caller's own connection; counts only (nothing written);
 * a list the stored token has no scope for → needsReconnect + the Reconnect line; resumable cursor.
 * Zoho is a fake fetch; the connection store is mocked; values are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  conn: { refreshToken: "rt" as string | null, orgId: "600" as string | null, orgName: "Org", connectedAt: null },
  dropped: 0,
  noScope: [] as string[],
  expired: false,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: "t1", role: st.role, canManage: true, admin: {} }),
  readConnection: async () => st.conn,
  zohoAccessToken: async () => (st.expired ? "old" : "access"),
  dropZohoAccessToken: async () => { st.dropped += 1; st.expired = false; },
}));

import { POST } from "./route";

const urls: URL[] = [];
function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const u = new URL(String(input));
  urls.push(u);
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  if (auth !== "Zoho-oauthtoken access") return j({ code: 57, message: "You are not authorized to perform this operation" }, 401);
  const list = u.pathname.replace("/books/v3/", "");
  if (st.noScope.includes(list)) return j({ code: 57, message: "You are not authorized to perform this operation" }, 401);
  return j({ code: 0, [list]: [{ id: 1 }, { id: 2 }], page_context: { has_more_page: false } });
}

function req(body: unknown) {
  return new NextRequest("http://localhost:3001/api/integrations/zoho-books/fy-counts", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  urls.length = 0;
  st.role = "owner"; st.dropped = 0; st.noScope = []; st.expired = false;
  st.conn = { refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null };
  process.env.ZOHO_BOOKS_CLIENT_ID = "1000.TESTONLY";
  process.env.ZOHO_BOOKS_CLIENT_SECRET = "testonly-secret";
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ZOHO_BOOKS_CLIENT_ID; delete process.env.ZOHO_BOOKS_CLIENT_SECRET; });

describe("R-2498 FY counts route", () => {
  it("counts FY 2025-26 of all five lists with date_start / date_end, read only", async () => {
    const res = await POST(req({ fy: "2025-26" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, fy: "2025-26", cursor: null, needsReconnect: [], counts: { invoices: 2, creditnotes: 2, bills: 2, expenses: 2, vendorpayments: 2 } });
    expect(urls.map((u) => u.pathname)).toEqual(["/books/v3/invoices", "/books/v3/creditnotes", "/books/v3/bills", "/books/v3/expenses", "/books/v3/vendorpayments"]);
    expect(urls.every((u) => u.searchParams.get("date_start") === "2025-04-01" && u.searchParams.get("date_end") === "2026-03-31" && u.searchParams.get("organization_id") === "600")).toBe(true);
  });

  it("an old connection without the new scopes → needsReconnect and the Reconnect line", async () => {
    st.noScope = ["creditnotes", "bills", "expenses", "vendorpayments"];
    const body = await (await POST(req({ fy: "2025-26" }))).json();
    expect(body.ok).toBe(true);
    expect(body.counts.invoices).toBe(2);
    expect(body.needsReconnect).toEqual(["creditnotes", "bills", "expenses", "vendorpayments"]);
    expect(body.message).toMatch(/^Reconnect to allow reading credit notes, bills, expenses/);
  });

  it("a stale cached token: dropped once and retried", async () => {
    st.expired = true;
    const body = await (await POST(req({ fy: "2025-26" }))).json();
    expect(st.dropped).toBe(1);
    expect(body.counts.bills).toBe(2);
  });

  it("refuses a bad FY or cursor, other roles, no connection", async () => {
    expect((await POST(req({ fy: "2025-27" }))).status).toBe(400);
    expect((await POST(req({ fy: "2025-26", cursor: { fy: "2025-26", list: "journals", page: 1, counts: {}, needsReconnect: [] } }))).status).toBe(400);
    st.role = "billing";
    expect((await POST(req({ fy: "2025-26" }))).status).toBe(403);
    st.role = null;
    expect((await POST(req({ fy: "2025-26" }))).status).toBe(401);
    st.role = "owner"; st.conn = { refreshToken: null, orgId: null, orgName: null, connectedAt: null };
    expect((await POST(req({ fy: "2025-26" }))).status).toBe(409);
    expect(urls.length).toBe(0);
  });
});
