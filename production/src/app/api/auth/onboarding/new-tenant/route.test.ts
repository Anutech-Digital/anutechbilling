/**
 * R-1843 — /welcome "new business" sends the business type; the route stores it on the tenant.
 * Missing / null → empty (= Pvt Ltd until set in Settings). Anything else → 400, nothing created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ inserts: [] as { table: string; row: Row }[], sessionUser: null as null | { id: string; email: string; user_metadata: Row } }));

function query(table: string) {
  const b = {
    select() { return b; },
    eq() { return b; },
    insert(row: Row) { db.inserts.push({ table, row }); return b; },
    delete() { return b; },
    maybeSingle: async () => ({ data: null, error: null }),
    then(res: (v: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(res); },
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({ from: (t: string) => query(t) }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: db.sessionUser } }) } }),
}));
vi.mock("@/lib/auth/tenant-match", () => ({ routeVerifiedSignupToCompany: async () => null }));

import { POST } from "./route";

const post = (body: unknown) => new NextRequest("https://app.example/api/auth/onboarding/new-tenant", {
  method: "POST", headers: { host: "app.example", "content-type": "application/json" }, body: JSON.stringify(body),
});
const tenantRows = () => db.inserts.filter((i) => i.table === "tenants").map((i) => i.row);

beforeEach(() => {
  db.inserts = [];
  db.sessionUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "ravi@gmail.com", user_metadata: { full_name: "Ravi" } };
});

describe("POST /api/auth/onboarding/new-tenant — business type (R-1843)", () => {
  it("'partnership' is stored on the new tenant", async () => {
    const res = await POST(post({ companyName: "Ravi & Sons", businessType: "partnership" }));
    expect(res.status).toBe(200);
    expect(tenantRows()).toHaveLength(1);
    expect(tenantRows()[0]).toMatchObject({ name: "Ravi & Sons", business_type: "partnership" });
  });

  it("skipped (missing or null) → empty, as before", async () => {
    await POST(post({ companyName: "Ravi Traders" }));
    await POST(post({ companyName: "Ravi Traders", businessType: null }));
    expect(tenantRows().map((r) => r.business_type)).toEqual([null, null]);
  });

  it("a wrong value is a 400 with a fix-it message, and nothing is created", async () => {
    const res = await POST(post({ companyName: "Ravi Traders", businessType: "huf" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Proprietorship, Partnership, LLP or Private Limited/);
    expect(db.inserts).toEqual([]);
  });
});
