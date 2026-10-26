/**
 * R-1979: Settings → Integrations → Meta. Status readable by owner / manager / billing; saving
 * and clearing owner-only; the CAPI token is SEALED before it is stored and never returned to a
 * browser (only a mask, only to the owner); a bad pixel id is refused.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "owner" } as { tenant_id: string; role: string } | null,
  secrets: {} as Record<string, unknown>,
  writes: [] as Array<{ op: string; data: Record<string, unknown> }>,
}));

function chain(table: string, user: boolean) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.upsert = (data: Record<string, unknown>) => { db.writes.push({ op: "upsert", data }); return Promise.resolve({ error: null }); };
  q.update = (data: Record<string, unknown>) => { db.writes.push({ op: "update", data }); return q; };
  const one = async () => ({ data: table === "users" && user ? db.me : db.secrets, error: null });
  q.single = one;
  q.maybeSingle = one;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) }, from: (t: string) => chain(t, true) }),
  createAdminClientFor: () => ({ from: (t: string) => chain(t, false) }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({
  trySealTenantSecrets: (patch: Record<string, unknown>) => ({
    ok: true,
    row: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === "string" ? `rosv1:sealed(${v.length})` : v])),
  }),
}));

import { GET, POST, DELETE } from "./route";

const post = (body: unknown) => POST(new NextRequest("https://x.invalid/api/integrations/meta-pixel", { method: "POST", body: JSON.stringify(body) }));
const TOKEN = ["EAAB", "testonly", "x".repeat(24)].join("-"); // built at run time — a throwaway, never a real token

beforeEach(() => { db.me = { tenant_id: "T1", role: "owner" }; db.secrets = {}; db.writes = []; });

describe("R-1979 Meta integration route", () => {
  it("owner saves pixel id + token → token sealed, pixel id stored as digits", async () => {
    const res = await post({ pixel_id: " 1234567890123456 ", capi_token: TOKEN, test_event_code: "TEST42" });
    expect(res.status).toBe(200);
    const w = db.writes.find((x) => x.op === "upsert")!.data;
    expect(w).toMatchObject({ tenant_id: "T1", meta_pixel_id: "1234567890123456", meta_test_event_code: "TEST42" });
    expect(w.meta_capi_token).toBe(`rosv1:sealed(${TOKEN.length})`);
    expect(JSON.stringify(w)).not.toContain(TOKEN);
  });

  it("a blank token box keeps the stored token (not written)", async () => {
    db.secrets = { meta_capi_token: "rosv1:old" };
    await post({ pixel_id: "1234567890123456" });
    expect(db.writes.find((x) => x.op === "upsert")!.data).not.toHaveProperty("meta_capi_token");
  });

  it("a pixel id that is not digits is refused, nothing written", async () => {
    const res = await post({ pixel_id: "<script>alert(1)</script>" });
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it("only the owner may save or clear", async () => {
    db.me = { tenant_id: "T1", role: "manager" };
    expect((await post({ pixel_id: "1234567890123456" })).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  it("GET: a manager sees the pixel id and that a token is set — never the token or its mask", async () => {
    db.me = { tenant_id: "T1", role: "manager" };
    db.secrets = { meta_pixel_id: "1234567890123456", meta_capi_token: "rosv1:abc", meta_test_event_code: null };
    const j = await (await GET(new NextRequest("https://x.invalid/api/integrations/meta-pixel"))).json();
    expect(j).toMatchObject({ ok: true, pixel_id: "1234567890123456", capi_token_set: true, capi_token_mask: null, can_manage: false });
    expect(JSON.stringify(j)).not.toContain("rosv1:abc");
  });

  it("DELETE clears pixel, token and test code", async () => {
    await DELETE();
    expect(db.writes[0]).toEqual({ op: "update", data: { meta_pixel_id: null, meta_capi_token: null, meta_test_event_code: null } });
  });
});
