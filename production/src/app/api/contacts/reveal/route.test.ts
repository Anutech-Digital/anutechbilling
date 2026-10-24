/**
 * R-1009 — POST /api/contacts/reveal: the "explicit call / email action" that hands a masked
 * role the one real number it is about to dial, read through its own RLS, and logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "33333333-3333-4333-8333-333333333333";

const db = vi.hoisted(() => ({
  role: "sales" as string,
  row: { contact_phone: "+91 98765 43210" } as Record<string, unknown> | null,
  selected: [] as { table: string; cols: string; eq: [string, unknown][] }[],
  logs: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    const rec = { table, cols: "", eq: [] as [string, unknown][] };
    const q: Record<string, unknown> = {};
    q.select = (c: string) => { rec.cols = c; db.selected.push(rec); return q; };
    q.eq = (k: string, v: unknown) => { rec.eq.push([k, v]); return q; };
    const one = async () => {
      if (table === "users") return { data: { tenant_id: "T1", role: db.role }, error: null };
      return { data: db.row, error: null };
    };
    q.single = one;
    q.maybeSingle = one;
    return q;
  };
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@example.invalid" } } }) },
      from: chain,
    }),
    createAdminClientFor: () => ({
      from: () => ({ insert: async (row: Record<string, unknown>) => { db.logs.push(row); return { error: null }; } }),
    }),
  };
});
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";
import { resetRateLimiter } from "@/lib/security/rate-limit";

const call = (body: unknown) =>
  POST(new NextRequest("https://example.invalid/api/contacts/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  db.role = "sales";
  db.row = { contact_phone: "+91 98765 43210" };
  db.selected = [];
  db.logs = [];
  resetRateLimiter();
});

describe("POST /api/contacts/reveal", () => {
  it("sales pressing Call on an assigned lead gets the real number, and it is logged", async () => {
    const res = await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: "+91 98765 43210" });
    const read = db.selected.find((s) => s.table === "leads")!;
    expect(read.cols).toBe("contact_phone");
    expect(read.eq).toEqual([["id", LEAD], ["tenant_id", "T1"]]);
    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({ tenant_id: "T1", user_id: ME, action: "reveal_contact", entity: "lead", entity_id: LEAD });
    expect(String(db.logs[0].label)).not.toContain("98765");
  });

  it("the partner agent (no can_contact_customers) is refused and nothing is read", async () => {
    db.role = "partner_agent";
    const res = await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" });
    expect(res.status).toBe(403);
    expect(db.selected.filter((s) => s.table === "leads")).toEqual([]);
    expect(db.logs).toEqual([]);
  });

  it("a column that is not a contact column is refused (no reading other fields through this door)", async () => {
    const res = await call({ table: "leads", id: LEAD, field: "notes", purpose: "call" });
    expect(res.status).toBe(400);
    expect(db.selected.filter((s) => s.table === "leads")).toEqual([]);
  });

  it("a record RLS hides (not assigned to this seller) is a 404 with a plain sentence", async () => {
    db.row = null;
    const res = await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not open/i);
    expect(db.logs).toEqual([]);
  });

  it("an empty number says there is none saved", async () => {
    db.row = { contact_phone: null };
    const res = await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/No phone/);
  });

  it("works for customers and contacts too", async () => {
    db.row = { contact_email: "a@b.in", email: "a@b.in" };
    expect((await call({ table: "customers", id: LEAD, field: "contact_email", purpose: "email" })).status).toBe(200);
    expect((await call({ table: "contacts", id: LEAD, field: "email", purpose: "email" })).status).toBe(200);
    expect(db.logs.map((l) => l.entity)).toEqual(["customer", "contact"]);
  });

  it("more than 60 reveals in an hour is refused — a phone book cannot be copied one click at a time", async () => {
    for (let i = 0; i < 60; i++) expect((await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" })).status).toBe(200);
    const res = await call({ table: "leads", id: LEAD, field: "contact_phone", purpose: "call" });
    expect(res.status).toBe(429);
  });
});
