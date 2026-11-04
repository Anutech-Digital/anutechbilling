/**
 * R-2359 — POST /api/integrations/zoho-books/payment-match: owner/accountant only, tenant-scoped
 * bank line read on the server, read-only Zoho, and every refusal with a next step (§24).
 * Zoho is never called (fetch is a fake); the connection store is mocked; values are made up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT = "11111111-0000-4000-8000-00000000e1ce";
const OTHER = "22222222-0000-4000-8000-0000000a0700";
const LINE_ID = "33333333-0000-4000-8000-000000000613";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  conn: { refreshToken: "rt" as string | null, orgId: "600" as string | null, orgName: "Org", connectedAt: null },
  lines: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
  writes: 0,
  dropped: 0,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : {
    userId: "u1", tenantId: TENANT, role: st.role, canManage: true,
    admin: {
      from: (t: string) => {
        const f: Array<[string, unknown]> = [];
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (k: string, v: unknown) => { f.push([k, v]); st.filters.push([k, v]); return q; },
          maybeSingle: async () => ({ data: t === "bank_transactions" ? st.lines.find((r) => f.every(([k, v]) => r[k] === v)) ?? null : null, error: null }),
          update: () => { st.writes += 1; return q; },
          insert: () => { st.writes += 1; return q; },
          upsert: () => { st.writes += 1; return q; },
        };
        return q;
      },
    },
  }),
  readConnection: async () => st.conn,
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => { st.dropped += 1; },
}));

import { POST } from "./route";

let zohoStatus = 200;
const zohoCalls: Array<{ url: string; method: string }> = [];
function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  zohoCalls.push({ url: url.toString(), method: init?.method ?? "GET" });
  if (zohoStatus !== 200) return Promise.resolve(new Response(JSON.stringify({ code: 57 }), { status: zohoStatus }));
  const path = url.pathname.replace("/books/v3", "");
  const json = (b: object) => Promise.resolve(new Response(JSON.stringify({ code: 0, ...b }), { status: 200 }));
  if (path === "/customerpayments") {
    const hit = url.searchParams.get("reference_number_contains") === "IDFB6202M2890149";
    return json({ customerpayments: hit ? [{ payment_id: "p1", payment_number: "7801", date: "2026-07-21", amount: 27081, reference_number: "IDFB6202M2890149", customer_id: "c1", customer_name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED" }] : [], page_context: { has_more_page: false } });
  }
  if (path === "/customerpayments/p1") return json({ payment: { payment_id: "p1", amount: 27081, reference_number: "IDFB6202M2890149", customer_id: "c1", customer_name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", invoices: [{ invoice_id: "i1", invoice_number: "INV/26-27/0613", amount_applied: 27081 }] } });
  if (path === "/invoices/i1") return json({ invoice: { invoice_number: "INV/26-27/0613", gst_no: "07AAACS0000A1Z5", line_items: [{ name: "Google Workspace Business Starter", quantity: 9, rate: 2550 }] } });
  return Promise.resolve(new Response("{}", { status: 404 }));
}

const req = (body: unknown) => new NextRequest("http://localhost:3001/api/integrations/zoho-books/payment-match", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  st.role = "owner";
  st.conn = { refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null };
  st.lines = [
    { id: LINE_ID, tenant_id: TENANT, txn_date: "2026-07-21", credit: 27081, reference: null, description: "NEFT CR-IDFB0080202-SUPREME MEDIA-IDFB6202M2890149" },
    { id: "44444444-0000-4000-8000-000000000001", tenant_id: OTHER, txn_date: "2026-07-21", credit: 5, reference: null, description: "x" },
  ];
  st.filters = []; st.writes = 0; st.dropped = 0; zohoStatus = 200; zohoCalls.length = 0;
  vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "test-id");
  vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("R-2359 payment-match route", () => {
  it("owner: finds the Zoho payment by the line's UTR; reads only, writes nothing", async () => {
    const res = await POST(req({ transactionId: LINE_ID }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.kind).toBe("match");
    expect(body.result.match.invoices[0].number).toBe("INV/26-27/0613");
    expect(body.result.match.customer.gstin).toBe("07AAACS0000A1Z5");
    expect(st.filters).toContainEqual(["tenant_id", TENANT]);
    expect(st.writes).toBe(0);
    expect(zohoCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("accountant may; manager / sales may not (403 with a next step)", async () => {
    st.role = "accountant";
    expect((await POST(req({ transactionId: LINE_ID }))).status).toBe(200);
    for (const role of ["manager", "sales"]) {
      st.role = role;
      const res = await POST(req({ transactionId: LINE_ID }));
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.next.label).toBeTruthy();
    }
  });

  it("another tenant's bank line → 404, Zoho never asked", async () => {
    const res = await POST(req({ transactionId: "44444444-0000-4000-8000-000000000001" }));
    expect(res.status).toBe(404);
    expect(zohoCalls).toHaveLength(0);
  });

  it("Zoho not connected → 409 'Connect Zoho Books' → Settings", async () => {
    st.conn = { ...st.conn, refreshToken: null };
    const res = await POST(req({ transactionId: LINE_ID }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "not_connected", error: "Zoho Books is not connected.", next: { label: "Connect Zoho Books", href: "/settings?tab=integrations" } });
    expect(body.why).toBeTruthy();
  });

  it("token refused (expired / old connection without payments permission) → retried once, then reconnect step", async () => {
    zohoStatus = 401;
    const res = await POST(req({ transactionId: LINE_ID }));
    const body = await res.json();
    expect(st.dropped).toBe(1);
    expect(body).toMatchObject({ ok: false, code: "reconnect", next: { label: "Disconnect and connect Zoho Books again", href: "/settings?tab=integrations" } });
    expect(JSON.stringify(body)).not.toContain("access");
  });

  it("no match in Zoho → ok with kind none (the sheet says what was tried)", async () => {
    st.lines[0].description = "NEFT CR-IDFB0080202-SUPREME MEDIA-IDFB0000000999999";
    const body = await (await POST(req({ transactionId: LINE_ID }))).json();
    expect(body.result.kind).toBe("none");
  });
});
