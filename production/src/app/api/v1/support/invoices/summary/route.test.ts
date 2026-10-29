/**
 * R-2079 — GET /api/v1/support/invoices/summary?from&to: the support revenue DSP shows must
 * come from Billing's issued GST tax invoices, not from DSP's own payments.
 *
 * Driven against an in-memory TWO-tenant database that applies the filters the route really
 * sends, so a route that drops `.eq("tenant_id", …)` or the status / document filters goes red.
 * Fake fixtures only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  auth: null as null | { tenantId: string; keyId: string; scopes: string[] },
}));

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) => filters.every((f) => {
    const v = r[f.col];
    switch (f.op) {
      case "eq": return v === f.val;
      case "neq": return v !== f.val;
      case "in": return (f.val as unknown[]).includes(v);
      case "gte": return String(v) >= String(f.val);
      case "lte": return String(v) <= String(f.val);
      default: throw new Error(`fake db: unsupported filter ${f.op}`);
    }
  }));
}

vi.mock("@/lib/api-keys/auth", () => ({ authenticateApiKey: async () => db.auth }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Filter[] = [];
      let range: [number, number] | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push({ op: "eq", col, val }); return chain; },
        neq: (col: string, val: unknown) => { filters.push({ op: "neq", col, val }); return chain; },
        in: (col: string, val: unknown) => { filters.push({ op: "in", col, val }); return chain; },
        gte: (col: string, val: unknown) => { filters.push({ op: "gte", col, val }); return chain; },
        lte: (col: string, val: unknown) => { filters.push({ op: "lte", col, val }); return chain; },
        order: () => chain,
        range: (a: number, b: number) => { range = [a, b]; return chain; },
        then: (ok: (v: unknown) => unknown) => {
          const all = applyFilters(db.tables[table] ?? [], filters);
          const rows = range ? all.slice(range[0], range[1] + 1) : all;
          return Promise.resolve(ok({ data: rows, error: null }));
        },
      };
      return chain;
    },
  }),
}));

import { GET } from "./route";

const supStd = (tenant = TENANT_A) => `SUP-STANDARD-YR-${tenant.replace(/-/g, "")}`;
const supEnt = (tenant = TENANT_A) => `SUP-ENTERPRISE-MO-${tenant.replace(/-/g, "")}`;

function inv(over: Row): Row {
  return {
    id: "inv-x", tenant_id: TENANT_A, invoice_date: "2026-10-05", status: "paid",
    document_kind: "tax_invoice", amount: 1180, taxable_value: 1000, tax_amount: 180, tax_rate: 18,
    line_items: [{ id: "l1", item_id: supStd(), name: "Standard Support", qty: 1, rate: 1000, cost: 0 }],
    ...over,
  };
}

async function call(qs = "from=2026-10-01&to=2026-10-31") {
  const res = await GET(new NextRequest(`https://ros.invalid/api/v1/support/invoices/summary?${qs}`));
  return { status: res.status, body: await res.json() as Record<string, unknown> & {
    by_plan: Row[]; by_month: Row[];
  } };
}

beforeEach(() => {
  db.auth = { tenantId: TENANT_A, keyId: "key-a", scopes: ["read"] };
  db.tables = { invoices: [], credit_notes: [] };
});

describe("R-2079 support invoice summary — scoping", () => {
  it("counts an issued support tax invoice of the key's tenant", async () => {
    db.tables.invoices = [inv({ id: "a1" })];
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ currency: "INR", total_taxable: 1000, total_gst: 180, total_with_gst: 1180, count: 1 });
    expect(body.by_plan).toEqual([{ plan_key: "standard", taxable: 1000, gst: 180, total: 1180, count: 1 }]);
    expect(body.by_month).toEqual([{ month: "2026-10", taxable: 1000, total: 1180, count: 1 }]);
  });

  it("another tenant's support invoice is excluded", async () => {
    db.tables.invoices = [
      inv({ id: "a1" }),
      inv({ id: "b1", tenant_id: TENANT_B, amount: 11800, taxable_value: 10000, tax_amount: 1800,
        line_items: [{ id: "l", item_id: supStd(TENANT_B), name: "Std", qty: 1, rate: 10000, cost: 0 }] }),
    ];
    const { body } = await call();
    expect(body.count).toBe(1);
    expect(body.total_with_gst).toBe(1180);
  });

  it("an invoice with no support line is excluded; a mixed invoice counts only its support share", async () => {
    db.tables.invoices = [
      inv({ id: "ws", line_items: [{ id: "l", item_id: "GWS-BUSINESS-STARTER", name: "Workspace", qty: 10, rate: 100, cost: 80 }] }),
      inv({ id: "mixed", amount: 3540, taxable_value: 3000, tax_amount: 540, line_items: [
        { id: "l1", item_id: "GWS-BUSINESS-STARTER", name: "Workspace", qty: 2, rate: 1000, cost: 800 },
        { id: "l2", item_id: supStd(), name: "Standard Support", qty: 1, rate: 1000, cost: 0 },
      ] }),
    ];
    const { body } = await call();
    expect(body.count).toBe(1);
    expect(body).toMatchObject({ total_taxable: 1000, total_gst: 180, total_with_gst: 1180 });
  });

  it("drafts, void (cancelled), bills of supply and Zoho opening invoices are excluded", async () => {
    db.tables.invoices = [
      inv({ id: "draft", status: "draft" }),
      inv({ id: "void", status: "void" }),
      inv({ id: "bos", document_kind: "bill_of_supply", tax_amount: 0, amount: 1000 }),
      inv({ id: "open", document_kind: "opening_invoice" }),
      inv({ id: "ok", status: "pending" }),
      inv({ id: "late", status: "overdue" }),
    ];
    const { body } = await call();
    expect(body.count).toBe(2);
    expect(body.total_with_gst).toBe(2360);
  });

  it("an invoice outside the date range is excluded (IST dates, both ends inclusive)", async () => {
    db.tables.invoices = [
      inv({ id: "before", invoice_date: "2026-09-30" }),
      inv({ id: "first", invoice_date: "2026-10-01" }),
      inv({ id: "last", invoice_date: "2026-10-31" }),
      inv({ id: "after", invoice_date: "2026-11-01" }),
    ];
    const { body } = await call();
    expect(body.count).toBe(2);
  });

  it("a credit note against a support invoice is subtracted (in its own month)", async () => {
    db.tables.invoices = [inv({ id: "a1", invoice_date: "2026-09-20" }), inv({ id: "a2" })];
    db.tables.credit_notes = [
      { id: "cn1", tenant_id: TENANT_A, invoice_id: "a1", credit_date: "2026-10-10", amount: 590, taxable_value: 500, tax_amount: 90 },
    ];
    const { body } = await call("from=2026-09-01&to=2026-10-31");
    expect(body).toMatchObject({ total_taxable: 1500, total_gst: 270, total_with_gst: 1770, count: 2 });
    expect(body.by_month).toEqual([
      { month: "2026-09", taxable: 1000, total: 1180, count: 1 },
      { month: "2026-10", taxable: 500, total: 590, count: 1 },
    ]);
    expect(body.by_plan).toEqual([{ plan_key: "standard", taxable: 1500, gst: 270, total: 1770, count: 2 }]);
  });

  it("credit notes on non-support invoices, other tenants' or out-of-range dates are not subtracted", async () => {
    db.tables.invoices = [
      inv({ id: "a1" }),
      inv({ id: "ws", line_items: [{ id: "l", item_id: "GWS-X", name: "Workspace", qty: 1, rate: 1000, cost: 0 }] }),
      inv({ id: "b1", tenant_id: TENANT_B, line_items: [{ id: "l", item_id: supStd(TENANT_B), name: "S", qty: 1, rate: 1000, cost: 0 }] }),
    ];
    db.tables.credit_notes = [
      { id: "cn-ws", tenant_id: TENANT_A, invoice_id: "ws", credit_date: "2026-10-10", amount: 1180, taxable_value: 1000, tax_amount: 180 },
      { id: "cn-b", tenant_id: TENANT_B, invoice_id: "b1", credit_date: "2026-10-10", amount: 1180, taxable_value: 1000, tax_amount: 180 },
      { id: "cn-late", tenant_id: TENANT_A, invoice_id: "a1", credit_date: "2026-11-02", amount: 1180, taxable_value: 1000, tax_amount: 180 },
    ];
    const { body } = await call();
    expect(body).toMatchObject({ total_taxable: 1000, total_with_gst: 1180, count: 1 });
  });

  it("a credit note on a mixed invoice is subtracted only in the support share", async () => {
    db.tables.invoices = [inv({ id: "mixed", amount: 3540, taxable_value: 3000, tax_amount: 540, line_items: [
      { id: "l1", item_id: "GWS-X", name: "Workspace", qty: 2, rate: 1000, cost: 800 },
      { id: "l2", item_id: supStd(), name: "Standard Support", qty: 1, rate: 1000, cost: 0 },
    ] })];
    db.tables.credit_notes = [
      { id: "cn", tenant_id: TENANT_A, invoice_id: "mixed", credit_date: "2026-10-20", amount: 1770, taxable_value: 1500, tax_amount: 270 },
    ];
    const { body } = await call();
    expect(body).toMatchObject({ total_taxable: 500, total_gst: 90, total_with_gst: 590 });
  });

  it("splits by plan and keeps paise exact", async () => {
    db.tables.invoices = [
      inv({ id: "s", amount: 1179.99, taxable_value: 999.99, tax_amount: 180 }),
      inv({ id: "e", amount: 590.59, taxable_value: 500.5, tax_amount: 90.09,
        line_items: [{ id: "l", item_id: supEnt(), name: "Enterprise Support", qty: 1, rate: 500.5, cost: 0 }] }),
    ];
    const { body } = await call();
    expect(body).toMatchObject({ total_taxable: 1500.49, total_gst: 270.09, total_with_gst: 1770.58, count: 2 });
    expect(body.by_plan).toEqual([
      { plan_key: "enterprise", taxable: 500.5, gst: 90.09, total: 590.59, count: 1 },
      { plan_key: "standard", taxable: 999.99, gst: 180, total: 1179.99, count: 1 },
    ]);
  });
});

describe("R-2079 support invoice summary — request checks", () => {
  it("401 without a valid key, before any read", async () => {
    db.auth = null;
    expect((await call()).status).toBe(401);
  });

  it("403 for a key without the read scope", async () => {
    db.auth = { tenantId: TENANT_A, keyId: "k", scopes: ["telecalling"] };
    expect((await call()).status).toBe(403);
  });

  it.each([
    ["", "missing both"],
    ["from=2026-10-01", "missing to"],
    ["from=2026-13-01&to=2026-13-31", "bad month"],
    ["from=2026-02-30&to=2026-03-01", "no such day"],
    ["from=2026-10-31&to=2026-10-01", "from after to"],
    ["from=01-10-2026&to=31-10-2026", "wrong format"],
  ])("400 on %s (%s)", async (qs) => {
    const { status, body } = await call(qs);
    expect(status).toBe(400);
    expect(body.code).toBe("bad_request");
  });

  it("an empty period answers zeros, not an error", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toEqual({ currency: "INR", from: "2026-10-01", to: "2026-10-31", total_taxable: 0, total_gst: 0, total_with_gst: 0, count: 0, by_plan: [], by_month: [] });
  });
});
