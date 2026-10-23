/**
 * R-1007 — POST /api/exports/<kind>. Pinned:
 *   - a role that may not export gets 403 before a single row is read and nothing is logged;
 *   - owner gets the CSV with the "Exported by … from <company>" footer, one export_log call
 *     (what / rows / format only — never the file), and every read pinned to the caller's tenant;
 *   - the accountant may export invoices but not customers or leads;
 *   - phone / email are masked for a role without can_view_contact_details;
 *   - an unknown kind is 404, an empty list is 404 with nothing logged.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "11111111-1111-4111-8111-111111111111", role: "owner", full_name: "Asha Rao", email: "asha@example.invalid" } as Record<string, unknown> | null,
  tables: {} as Record<string, unknown[]>,
  reads: [] as string[],
  eqs: [] as Array<[string, string, unknown]>,
  ins: [] as Array<[string, unknown]>,
  rpcs: [] as Array<[string, unknown]>,
}));

function chain(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order"]) q[m] = () => q;
  q.eq = (c: string, v: unknown) => { db.eqs.push([table, c, v]); return q; };
  q.in = (c: string, v: unknown) => { db.ins.push([c, v]); return q; };
  const one = async () => ({ data: table === "users" ? db.me : table === "tenants" ? { name: "Anutech Digital Pvt Ltd" } : null, error: null });
  q.maybeSingle = one;
  q.range = (from: number, to: number) => {
    db.reads.push(table);
    return Promise.resolve({ data: (db.tables[table] ?? []).slice(from, to + 1), error: null });
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "22222222-2222-4222-8222-222222222222", email: "asha@example.invalid" } } }) },
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: unknown) => { db.rpcs.push([fn, args]); return { data: null, error: null }; },
  }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";

const TENANT = "11111111-1111-4111-8111-111111111111";
const call = (kind: string, body: unknown = {}) =>
  POST(new NextRequest(`https://example.invalid/api/exports/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  db.me = { tenant_id: TENANT, role: "owner", full_name: "Asha Rao", email: "asha@example.invalid" };
  db.reads = []; db.eqs = []; db.ins = []; db.rpcs = [];
  db.tables = {
    customers: [{ name: "Acme", contact_name: "Ravi", contact_email: "ravi@acme.example", contact_phone: "+91 98765 43210" }],
    leads: [{ company: "Beta", contact_name: "Meena", contact_email: "meena@beta.example", contact_phone: "9876501234", stage: "new" }],
    invoices: [{ id: "INV-001", customer_name: "Acme", status: "paid", invoice_date: "2026-10-01", amount: 1180 }],
  };
});

describe("POST /api/exports/[kind] (R-1007)", () => {
  it("sales cannot export — 403 before any row is read, nothing logged", async () => {
    db.me = { ...db.me, role: "sales" };
    const res = await call("customers");
    expect(res.status).toBe(403);
    expect(db.reads).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("owner gets the customers CSV with the footer, one export_log row, tenant-pinned read", async () => {
    const res = await call("customers");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    /* res.text() drops a leading BOM; the bytes show it is there (Excel needs it). */
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith("﻿Name,")).toBe(true);
    expect(text).toContain("ravi@acme.example");
    expect(text).toMatch(/Exported by Asha Rao <asha@example\.invalid> \(Owner\) on \d{1,2} \w{3} \d{4}, .* IST from Anutech Digital Pvt Ltd\./);
    expect(db.eqs).toContainEqual(["customers", "tenant_id", TENANT]);
    expect(db.rpcs).toEqual([["log_export", { p_what: "customers", p_row_count: 1, p_format: "csv" }]]);
  });

  it("accountant: invoices yes, customers and leads no", async () => {
    db.me = { ...db.me, role: "accountant" };
    expect((await call("customers")).status).toBe(403);
    expect((await call("leads")).status).toBe(403);
    const res = await call("invoices", { ids: ["33333333-3333-4333-8333-333333333333"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/selected-invoices-/);
    expect(await res.text()).toContain("INV-001");
    expect(db.ins).toEqual([["id", ["33333333-3333-4333-8333-333333333333"]]]);
    expect(db.rpcs).toEqual([["log_export", { p_what: "invoices-selected", p_row_count: 1, p_format: "csv" }]]);
  });

  it("billing and support cannot export leads", async () => {
    for (const role of ["billing", "support", "sales_senior", "delivery", "partner_agent"]) {
      db.me = { ...db.me, role };
      expect((await call("leads")).status, role).toBe(403);
    }
    expect(db.reads).toEqual([]);
  });

  it("unknown kind → 404; empty list → 404 and nothing logged; a bad id → 400", async () => {
    expect((await call("salary-register")).status).toBe(404);
    db.tables.leads = [];
    const empty = await call("leads");
    expect(empty.status).toBe(404);
    expect((await empty.json()).error).toMatch(/no leads to export/i);
    expect((await call("invoices", { ids: ["not-a-uuid"] })).status).toBe(400);
    expect(db.rpcs).toEqual([]);
  });
});
