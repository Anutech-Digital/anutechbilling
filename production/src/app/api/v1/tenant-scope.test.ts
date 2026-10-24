/**
 * R-1404 — the API-key export endpoints (/api/v1/customers and its sub-resources) hand out
 * ONLY the key's tenant. These routes run on the admin client, so RLS does not protect them:
 * every query must carry the tenant itself. This test drives the real handlers against an
 * in-memory two-tenant database that applies the filters the route actually sends — a route
 * that drops `.eq("tenant_id", …)` would return Tenant B's rows here and go red.
 *
 * Tenant B is seeded with rows that would leak if only the customer id were checked: the same
 * customer id, the same customer number, the same contact email. Fake fixtures only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
/* Same customer id in both tenants — a lookup by id alone cannot tell them apart. */
const CUST = "cccccccc-0000-4000-8000-00000000000c";
const CUST_B_ONLY = "dddddddd-0000-4000-8000-00000000000d";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as { table: string; filters: Filter[] }[],
}));

function likeToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) => filters.every((f) => {
    const v = r[f.col];
    switch (f.op) {
      case "eq": return v === f.val;
      case "in": return (f.val as unknown[]).includes(v);
      case "ilike": return typeof v === "string" && likeToRegex(f.val as string).test(v);
      case "not-is-null": return v !== null && v !== undefined;
      default: return true;
    }
  }));
}

/** A supabase-js lookalike: records the filters, answers from the two-tenant dataset. */
function fakeAdmin() {
  return {
    from: (table: string) => {
      const q = { table, filters: [] as Filter[] };
      db.queries.push(q);
      let single = false;
      let range: [number, number] | null = null;
      let wantCount = false;
      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string }) => { wantCount = !!opts?.count; return chain; },
        eq: (col: string, val: unknown) => { q.filters.push({ op: "eq", col, val }); return chain; },
        in: (col: string, val: unknown) => { q.filters.push({ op: "in", col, val }); return chain; },
        ilike: (col: string, val: unknown) => { q.filters.push({ op: "ilike", col, val }); return chain; },
        not: (col: string, op: string, _v: unknown) => { if (op === "is") q.filters.push({ op: "not-is-null", col, val: null }); return chain; },
        order: () => chain,
        limit: () => chain,
        range: (a: number, b: number) => { range = [a, b]; return chain; },
        maybeSingle: () => { single = true; return chain; },
        then: (ok: (v: unknown) => unknown, _ko?: unknown) => {
          const all = applyFilters(db.tables[table] ?? [], q.filters);
          const rows = range ? all.slice(range[0], range[1] + 1) : all;
          const data = single ? (rows[0] ?? null) : rows;
          return Promise.resolve(ok({ data, error: null, count: wantCount ? all.length : null }));
        },
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/api-keys/auth", () => ({
  authenticateApiKey: async () => ({ tenantId: TENANT_A, keyId: "key-a", scopes: ["read"] }),
}));
vi.mock("@/lib/pdf/pdf-token", () => ({ pdfDownloadUrl: () => "https://ros.invalid/pdf" }));

import { GET as listCustomers } from "./customers/route";
import { GET as oneCustomer } from "./customers/[id]/route";
import { GET as invoices } from "./customers/[id]/invoices/route";
import { GET as payments } from "./customers/[id]/payments/route";
import { GET as quotes } from "./customers/[id]/quotes/route";
import { GET as subscriptions } from "./customers/[id]/subscriptions/route";

const customer = (tenant: string, id: string, n: string, email: string): Row => ({
  id, tenant_id: tenant, customer_number: n, name: `Customer ${n}`, contact_email: email,
  created_at: "2026-01-01T00:00:00Z", status: "active",
});

beforeEach(() => {
  db.queries = [];
  db.tables = {
    customers: [
      customer(TENANT_A, CUST, "C-0001", "shared@example.test"),
      customer(TENANT_B, CUST, "C-0001", "shared@example.test"),
      customer(TENANT_B, CUST_B_ONLY, "C-0002", "only-b@example.test"),
    ],
    contacts: [
      { tenant_id: TENANT_B, customer_id: CUST_B_ONLY, email: "only-b@example.test", is_primary: true },
    ],
    subscriptions: [
      { id: "S-A", tenant_id: TENANT_A, customer_id: CUST, status: "active", vendor: "google", seats: 5, mrr: 1000, start_date: "2026-01-01", renewal_quote_id: "Q-A" },
      { id: "S-B", tenant_id: TENANT_B, customer_id: CUST, status: "active", vendor: "zoho", seats: 50, mrr: 99000, start_date: "2026-01-01", renewal_quote_id: "Q-A" },
    ],
    invoices: [
      { id: "INV-A", tenant_id: TENANT_A, customer_id: CUST, quote_id: "Q-A", amount: 1180, status: "issued", invoice_date: "2026-02-01" },
      { id: "INV-B", tenant_id: TENANT_B, customer_id: CUST, quote_id: "Q-A", amount: 999999, status: "issued", invoice_date: "2026-02-01" },
    ],
    payments: [
      { id: "PAY-A", tenant_id: TENANT_A, customer_id: CUST, quote_id: "Q-A", status: "received", amount: 1180, method: "upi", received_at: "2026-02-02" },
      { id: "PAY-B", tenant_id: TENANT_B, customer_id: CUST, quote_id: "Q-A", status: "received", amount: 999999, method: "upi", received_at: "2026-02-02" },
    ],
    quotes: [
      { id: "Q-A", tenant_id: TENANT_A, customer_id: CUST, amount: 1180, status: "sent", created_date: "2026-01-15", public_token: "ta" },
      { id: "Q-B", tenant_id: TENANT_B, customer_id: CUST, amount: 999999, status: "sent", created_date: "2026-01-15", public_token: "tb" },
    ],
  };
});

const req = (path: string) => new NextRequest(`https://ros.invalid/api/v1/${path}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ids = (body: unknown) => (body as { id: string }[]).map((r) => r.id);

describe("R-1404 — /api/v1 exports stay inside the key's tenant", () => {
  it("list: only Tenant A's customers, and the total counts only them", async () => {
    const res = await listCustomers(req("customers?page=1&per_page=100"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: { id: string; name: string }[]; total: number };
    /* `id` is the customer number here — the same number exists in Tenant B, so the count is the proof. */
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0].name).toBe("Customer C-0001");
    expect(body.total).toBe(1);
  });

  it("lookup by email: an address that exists only in Tenant B (contact or customer) is not found", async () => {
    expect((await listCustomers(req("customers?email=only-b%40example.test"))).status).toBe(404);
  });

  it("lookup by email: the shared address resolves to Tenant A's customer", async () => {
    const res = await listCustomers(req("customers?email=shared%40example.test"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { billing_customer_id: string }).billing_customer_id).toBe("C-0001");
    /* And its status came from Tenant A's subscriptions, not B's. */
    expect(db.queries.filter((q) => q.table === "subscriptions")
      .every((q) => q.filters.some((f) => f.col === "tenant_id" && f.val === TENANT_A))).toBe(true);
  });

  it("one customer: Tenant B's own id / number are not found, even though the number is a real one", async () => {
    expect((await oneCustomer(req(`customers/${CUST_B_ONLY}`), ctx(CUST_B_ONLY))).status).toBe(404);
    expect((await oneCustomer(req("customers/C-0002"), ctx("C-0002"))).status).toBe(404);
    for (const h of [invoices, payments, quotes, subscriptions]) {
      expect((await h(req(`customers/${CUST_B_ONLY}/x`), ctx(CUST_B_ONLY))).status).toBe(404);
    }
  });

  it("sub-resources: the same customer id in Tenant B contributes nothing", async () => {
    expect(ids(await (await invoices(req(`customers/${CUST}/invoices`), ctx(CUST))).json())).toEqual(["INV-A"]);
    expect(ids(await (await payments(req(`customers/${CUST}/payments`), ctx(CUST))).json())).toEqual(["PAY-A"]);
    expect(ids(await (await quotes(req(`customers/${CUST}/quotes`), ctx(CUST))).json())).toEqual(["Q-A"]);
    expect(ids(await (await subscriptions(req(`customers/${CUST}/subscriptions`), ctx(CUST))).json())).toEqual(["S-A"]);
    /* Payment → invoice and quote → renews lookups are also tenant-bound (they go by quote id). */
    const pay = (await (await payments(req(`customers/${CUST}/payments`), ctx(CUST))).json()) as { invoice_id: string }[];
    expect(pay[0].invoice_id).toBe("INV-A");
    const q = (await (await quotes(req(`customers/${CUST}/quotes`), ctx(CUST))).json()) as { renews: { vendor: string }[] }[];
    expect(q[0].renews).toEqual([{ vendor: "google", domain: null }]);
  });

  it("every admin-client query these routes send carries the key's tenant", async () => {
    await listCustomers(req("customers?page=1&per_page=100"));
    await listCustomers(req("customers?email=shared%40example.test"));
    await oneCustomer(req(`customers/${CUST}`), ctx(CUST));
    for (const h of [invoices, payments, quotes, subscriptions]) await h(req(`customers/${CUST}/x`), ctx(CUST));
    expect(db.queries.length).toBeGreaterThan(10);
    const unscoped = db.queries.filter((q) => !q.filters.some((f) => f.op === "eq" && f.col === "tenant_id" && f.val === TENANT_A));
    expect(unscoped.map((q) => q.table)).toEqual([]);
  });
});
