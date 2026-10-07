/**
 * R-327 — API key scopes on create and change.
 * Pinned: a key can be created with the telecalling scope (the name requireScope() checks,
 * R-050); unknown/empty scopes are refused; changing scopes is owner-only and tenant-scoped;
 * the secret is returned once on create and never by the list or the scope change.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { API_SCOPES, parseScopes } from "@/lib/api-keys/scopes";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "owner" } as { tenant_id: string; role: string } | null,
  row: null as Record<string, unknown> | null,
  writes: [] as Array<{ op: string; data: unknown; filters: Array<[string, string, unknown]>; select?: string }>,
}));

function chain(table: string) {
  const w = { op: "select", data: undefined as unknown, filters: [] as Array<[string, string, unknown]>, select: undefined as string | undefined };
  const q: Record<string, unknown> = {};
  q.select = (cols: string) => { w.select = cols; return q; };
  q.order = () => q;
  q.eq = (c: string, v: unknown) => { w.filters.push(["eq", c, v]); return q; };
  q.is = (c: string, v: unknown) => { w.filters.push(["is", c, v]); return q; };
  q.insert = (data: unknown) => { w.op = "insert"; w.data = data; db.writes.push(w); return q; };
  q.update = (data: unknown) => { w.op = "update"; w.data = data; db.writes.push(w); return q; };
  const one = async () => ({ data: table === "users" ? db.me : db.row, error: null });
  q.single = one;
  q.maybeSingle = one;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) },
    from: (t: string) => chain(t),
  }),
}));

import { POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

const post = (b: unknown) =>
  POST(new NextRequest("https://example.invalid/api/settings/api-keys", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }));
const patch = (b: unknown) =>
  PATCH(new NextRequest("https://example.invalid/api/settings/api-keys/K1", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }), { params: Promise.resolve({ id: "K1" }) });

beforeEach(() => {
  db.me = { tenant_id: "T1", role: "owner" };
  db.row = { id: "K1", label: "DSP", key_prefix: "rsk_live_ab", scopes: ["read"], created_at: "2026-10-07T00:00:00Z" };
  db.writes = [];
});

describe("scope names match requireScope (R-050)", () => {
  it("lists exactly read + telecalling", () => {
    expect([...API_SCOPES]).toEqual(["read", "telecalling"]);
  });
  it("parseScopes dedupes, orders, and refuses empty/unknown", () => {
    expect(parseScopes(["telecalling", "read", "read"])).toEqual(["read", "telecalling"]);
    expect(parseScopes([])).toBeNull();
    expect(parseScopes(["admin"])).toBeNull();
    expect(parseScopes("read")).toBeNull();
  });
});

describe("POST /api/settings/api-keys — scopes on create", () => {
  it("creates a key with the telecalling scope; secret returned once, hash never", async () => {
    db.row = { ...db.row, scopes: ["read", "telecalling"] };
    const res = await post({ label: "Dialer", scopes: ["telecalling", "read"] });
    expect(res.status).toBe(200);
    const ins = db.writes.find((w) => w.op === "insert")!;
    expect((ins.data as { scopes: string[] }).scopes).toEqual(["read", "telecalling"]);
    expect(ins.select).not.toMatch(/key_hash/);
    const body = await res.json();
    expect(typeof body.key).toBe("string");
    expect(body.key_hash).toBeUndefined();
  });
  it("no scopes in the body → default read", async () => {
    await post({ label: "x" });
    expect((db.writes[0].data as { scopes: string[] }).scopes).toEqual(["read"]);
  });
  it("unknown or empty scopes → 400, nothing written", async () => {
    expect((await post({ scopes: ["admin"] })).status).toBe(400);
    expect((await post({ scopes: [] })).status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });
  it("non-owner → 403", async () => {
    db.me = { tenant_id: "T1", role: "manager" };
    expect((await post({ scopes: ["read"] })).status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });
});

describe("PATCH /api/settings/api-keys/{id} — change scopes", () => {
  it("owner changes scopes; tenant + not-revoked filtered; response has no key or hash", async () => {
    db.row = { id: "K1", label: "DSP", key_prefix: "rsk_live_ab", scopes: ["read", "telecalling"] };
    const res = await patch({ scopes: ["read", "telecalling"] });
    expect(res.status).toBe(200);
    const upd = db.writes.find((w) => w.op === "update")!;
    expect(upd.data).toEqual({ scopes: ["read", "telecalling"] });
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "id", "K1"], ["eq", "tenant_id", "T1"], ["is", "revoked_at", null]]));
    expect(upd.select).not.toMatch(/key_hash/);
    const body = await res.json();
    expect(body.key).toBeUndefined();
    expect(body.key_hash).toBeUndefined();
    expect(body.scopes).toEqual(["read", "telecalling"]);
  });
  it.each(["manager", "sales", "billing", "support"])("%s → 403, nothing written", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await patch({ scopes: ["telecalling"] });
    expect(res.status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });
  it("invalid scopes → 400", async () => {
    expect((await patch({ scopes: [] })).status).toBe(400);
    expect((await patch({ scopes: ["write"] })).status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });
  it("key not found / revoked → 404", async () => {
    db.row = null;
    expect((await patch({ scopes: ["read"] })).status).toBe(404);
  });
});

describe("DELETE stays owner-only and tenant-scoped", () => {
  it("owner revokes with tenant filter", async () => {
    const res = await DELETE(new NextRequest("https://example.invalid/x", { method: "DELETE" }), { params: Promise.resolve({ id: "K1" }) });
    expect(res.status).toBe(200);
    expect(db.writes[0].filters).toEqual(expect.arrayContaining([["eq", "tenant_id", "T1"]]));
  });
  it("non-owner → 403", async () => {
    db.me = { tenant_id: "T1", role: "manager" };
    const res = await DELETE(new NextRequest("https://example.invalid/x", { method: "DELETE" }), { params: Promise.resolve({ id: "K1" }) });
    expect(res.status).toBe(403);
  });
});
