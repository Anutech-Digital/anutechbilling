/**
 * R-2402 — POST /api/integrations/zoho-books/bulk-match ("Reconcile from Zoho", bulk): owner /
 * accountant only; only the caller's OWN tenant's unmatched money-in lines of the account; a line
 * from elsewhere (or booked meanwhile) is skipped, never planned; one cached Zoho read of the window,
 * Zoho calls counted for pacing; a new customer's Zoho contact is read; nothing is written.
 * Zoho is a fake fetch; the connection store is mocked; values are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT = "11111111-0000-4000-8000-00000000e1ce";
const ACCOUNT = "55555555-0000-4000-8000-000000000001";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000009";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  conn: { refreshToken: "rt" as string | null, orgId: "600" as string | null, orgName: "Org", connectedAt: null },
  lines: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, string, string, unknown]>,
  writes: 0,
  busyOn: null as string | null,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : {
    userId: "u1", tenantId: TENANT, role: st.role, canManage: true,
    admin: {
      from: (table: string) => {
        const rows = table === "customers" ? st.customers : st.lines;
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (k: string, v: unknown) => { st.filters.push([table, "eq", k, v]); return q; },
          is: (k: string, v: unknown) => { st.filters.push([table, "is", k, v]); return q; },
          gt: (k: string, v: unknown) => { st.filters.push([table, "gt", k, v]); return q; },
          order: () => q,
          range: async () => ({ data: rows, error: null }),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
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
const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ code: 0, ...(b as object) }), { status }));
function fakeFetch(input: string | URL | Request) {
  const url = new URL(String(input));
  zohoCalls.push(url.pathname);
  if (st.busyOn && url.pathname.includes(st.busyOn)) {
    return Promise.resolve(new Response(JSON.stringify({ code: 44, message: "too many requests" }), { status: 429 }));
  }
  if (url.pathname.endsWith("/customerpayments")) {
    return json({
      customerpayments: [
        { payment_id: "p1", payment_number: "8692", date: "2026-10-31", amount: 3823, reference_number: "630466843630", customer_id: "zc-ranz", customer_name: "RANZ INTERNATIONAL LLC" },
      ],
      page_context: { has_more_page: false },
    });
  }
  if (url.pathname.endsWith("/customerpayments/p1")) {
    return json({ payment: { payment_id: "p1", payment_number: "8692", date: "2026-10-31", amount: 3823, reference_number: "630466843630", customer_id: "zc-ranz", customer_name: "RANZ INTERNATIONAL LLC", invoices: [{ invoice_id: "i1", invoice_number: "INV/26-27/1139", amount_applied: 3823 }] } });
  }
  if (url.pathname.endsWith("/invoices/i1")) {
    return json({ invoice: { invoice_id: "i1", invoice_number: "INV/26-27/1139", date: "2026-10-30", total: 3823, line_items: [{ name: "Google Workspace Business Starter", quantity: 1, rate: 3240, item_total: 3240, description: "ranz.ae Subscription Period: 1 Year/s (30/10/2026 - 29/10/2027)" }] } });
  }
  if (url.pathname.endsWith("/contacts/zc-ranz")) {
    return json({ contact: { contact_id: "zc-ranz", contact_name: "RANZ INTERNATIONAL LLC", place_of_contact: "DL", email: "ops@ranz.example", phone: "+971 50 000 0000" } });
  }
  return json({}, 404);
}

const req = (body: unknown) => new NextRequest("http://localhost:3001/api/integrations/zoho-books/bulk-match", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  clearZohoBatchCache();
  st.role = "owner";
  st.conn = { refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null };
  st.lines = [
    { id: L1, txn_date: "2026-10-31", credit: 3823, reference: null, description: "UPI-NAVAS K-navas@oksbi-SBIN0000001-630466843630-PAY" },
    { id: L2, txn_date: "2026-10-30", credit: 999, reference: null, description: "IMPS-1-SOMEONE-x" },
  ];
  st.customers = [];
  st.filters = []; st.writes = 0; st.busyOn = null; zohoCalls.length = 0;
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "test-id");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const tenantFilters = (table: string) => st.filters.filter(([t, op, k]) => t === table && op === "eq" && k === "tenant_id").map((f) => f[3]);

describe("R-2402 bulk-match route", () => {
  it("first call: the account's unmatched money-in line ids, own tenant only; no Zoho call", async () => {
    const res = await POST(req({ accountId: ACCOUNT }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, ids: [L1, L2], total: 2 });
    expect(tenantFilters("bank_transactions")).toEqual([TENANT]);
    expect(st.filters).toContainEqual(["bank_transactions", "eq", "bank_account_id", ACCOUNT]);
    expect(st.filters).toContainEqual(["bank_transactions", "is", "matched_to_type", null]);
    expect(zohoCalls).toEqual([]);
  });

  it("a page: the match by UTR, a new customer's Zoho contact (email / phone / state), Zoho calls counted, nothing written", async () => {
    const res = await POST(req({ accountId: ACCOUNT, txnIds: [L1, L2] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].result.kind).toBe("match");
    expect(body.rows[0].result.match).toMatchObject({ by: "utr", payment: { number: "8692" }, invoices: [{ number: "INV/26-27/1139" }] });
    expect(body.rows[0].contact).toMatchObject({ name: "RANZ INTERNATIONAL LLC", stateCode: "07", email: "ops@ranz.example", phone: "+971 50 000 0000" });
    expect(body.rows[1].result.kind).toBe("none");
    expect(body.zohoCalls).toBe(zohoCalls.length);
    expect(zohoCalls.filter((p) => p.endsWith("/customerpayments"))).toHaveLength(1);
    expect(tenantFilters("customers")).toEqual([TENANT]);
    expect(st.writes).toBe(0);
  });

  it("the window read is cached — a second page reads no payment list again", async () => {
    await POST(req({ accountId: ACCOUNT, txnIds: [L2] }));
    zohoCalls.length = 0;
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L2] }))).json();
    expect(body.zohoCalls).toBe(0);
  });

  it("tenant scoping: a line not among this tenant's unmatched lines (another company's, or booked meanwhile) is skipped, never planned", async () => {
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [OTHER] }))).json();
    expect(body).toMatchObject({ ok: true, rows: [], skipped: [OTHER], zohoCalls: 0 });
  });

  it("Zoho busy part way → the lines done so far + stopped (the page carries on later)", async () => {
    st.busyOn = "/invoices/";
    const body = await (await POST(req({ accountId: ACCOUNT, txnIds: [L1] }))).json();
    expect(body).toMatchObject({ ok: true, rows: [], stopped: { code: "busy" } });
  });

  it("only an owner or accountant", async () => {
    st.role = "sales";
    const res = await POST(req({ accountId: ACCOUNT }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only an owner or accountant can reconcile from Zoho Books.");
  });

  it("more than a page of lines is refused", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `aaaaaaaa-0000-4000-8000-00000000001${i}`);
    expect((await POST(req({ accountId: ACCOUNT, txnIds: ids }))).status).toBe(400);
  });

  it("not connected → says so, no Zoho call", async () => {
    st.conn = { refreshToken: null, orgId: null, orgName: "Org", connectedAt: null };
    const res = await POST(req({ accountId: ACCOUNT }));
    expect(res.status).toBe(409);
    expect(zohoCalls).toEqual([]);
  });
});
