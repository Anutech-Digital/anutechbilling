/**
 * R-2445 — /api/platform/gstin-claims: only a confirmed platform admin reaches the service-role
 * functions, and the stored "decided by" is the admin's own server-read email, never the body's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  calls: [] as { fn: string; args?: Record<string, unknown> }[],
  adminMade: 0,
  rpcError: null as { message: string; code?: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user }, error: null }) } }),
  createAdminClient: () => {
    st.adminMade += 1;
    return {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        st.calls.push({ fn, args });
        return st.rpcError ? { data: null, error: st.rpcError } : { data: fn === "platform_gstin_claims" ? [] : "approved", error: null };
      },
    };
  },
}));

import { GET, POST } from "./route";

const CLAIM = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const post = (body: unknown) =>
  POST(new Request("http://localhost:3001/api/platform/gstin-claims", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "pardeep@anutech.in");
  st.user = { id: "u1", email: "Pardeep@anutech.in", email_confirmed_at: "2026-01-01T00:00:00Z" };
  st.calls = []; st.adminMade = 0; st.rpcError = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("R-2445 platform GSTIN ownership queue", () => {
  it("refuses a signed-out caller, a non-admin and an unconfirmed admin email before the admin client exists", async () => {
    st.user = null;
    expect((await GET(new Request("http://x/api/platform/gstin-claims"))).status).toBe(401);
    st.user = { id: "u2", email: "owner@shop.in", email_confirmed_at: "2026-01-01" };
    expect((await post({ action: "approve", claimId: CLAIM })).status).toBe(403);
    st.user = { id: "u3", email: "pardeep@anutech.in", email_confirmed_at: null };
    expect((await post({ action: "approve", claimId: CLAIM })).status).toBe(403);
    expect(st.adminMade).toBe(0);
    expect(st.calls).toHaveLength(0);
  });

  it("approve stores the admin's own email (lower-cased), not one from the body", async () => {
    const res = await post({ action: "approve", claimId: CLAIM, note: "REG-06 matched", p_admin_email: "evil@x.in" });
    expect(res.status).toBe(200);
    expect(st.calls[0]).toEqual({
      fn: "platform_decide_gstin_claim",
      args: { p_claim: CLAIM, p_approve: true, p_admin_email: "pardeep@anutech.in", p_note: "REG-06 matched" },
    });
  });

  it("reject and revoke call the right functions; a revoke needs a reason", async () => {
    await post({ action: "reject", claimId: CLAIM });
    expect(st.calls[0].args?.p_approve).toBe(false);
    expect((await post({ action: "revoke", tenantId: TENANT })).status).toBe(400);
    await post({ action: "revoke", tenantId: TENANT, note: "Wrong company approved" });
    expect(st.calls.at(-1)).toEqual({
      fn: "platform_revoke_gstin_owner",
      args: { p_tenant: TENANT, p_admin_email: "pardeep@anutech.in", p_note: "Wrong company approved" },
    });
  });

  it("a SQL guard's next-step message reaches the admin (409); anything else is generic (500)", async () => {
    st.rpcError = { message: "X already holds GSTIN … revoke X first, then approve.", code: "22023" };
    const res = await post({ action: "approve", claimId: CLAIM });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/revoke X first/);
    st.rpcError = { message: "connection reset", code: "08006" };
    const res2 = await post({ action: "approve", claimId: CLAIM });
    expect(res2.status).toBe(500);
    expect((await res2.json()).error).not.toMatch(/connection reset/);
  });

  it("lists with a known status only", async () => {
    await GET(new Request("http://x/api/platform/gstin-claims?status=drop%20table"));
    expect(st.calls[0]).toEqual({ fn: "platform_gstin_claims", args: { p_status: "pending" } });
  });
});
