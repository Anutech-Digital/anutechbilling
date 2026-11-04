/**
 * R-1421: "Claim & merge" gave Pawan a bare 400 on staging.
 * The route's only 400 is body validation — reproduced here with an empty email box.
 *   · empty / missing email → 400 with a plain-English "type their email" message;
 *   · bad role → 400 "pick a role";
 *   · a valid body still goes to the RPC with the caller's OWN tenant (R-721/R-722 untouched);
 *   · an RPC refusal still comes back as 409 with its text unchanged;
 *   · a non-active owner is still refused (403) before the RPC is called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  me: { tenant_id: "t-1", role: "owner", is_active: true } as Record<string, unknown> | null,
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcError: null as { message: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-owner" } } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: st.me, error: null }) };
      return q;
    },
    rpc: async (fn: string, args: unknown) => {
      st.rpcCalls.push({ fn, args });
      return st.rpcError ? { data: null, error: st.rpcError } : { data: { merged: true }, error: null };
    },
  }),
}));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/team/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

beforeEach(() => {
  st.me = { tenant_id: "t-1", role: "owner", is_active: true };
  st.rpcCalls = [];
  st.rpcError = null;
});

describe("POST /api/team/claim (R-1421)", () => {
  it("empty email box → 400 with a plain reason, RPC never called", async () => {
    const res = await post({ email: "", role: "support" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Type their email address first/);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("missing email or broken body → same plain reason", async () => {
    for (const body of [{ role: "support" }, "not json"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Type their email address first/);
    }
  });

  it("not an email → 400 'doesn't look like an email'", async () => {
    const res = await post({ email: "deepak", role: "support" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/doesn't look like an email/);
  });

  it("unknown role → 400 'pick a role'", async () => {
    const res = await post({ email: "a@b.in", role: "partner_agent" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Pick a role/);
  });

  it("R-2110: role 'personal' → 400 'pick a role', RPC never called", async () => {
    const res = await post({ email: "a@b.in", role: "personal" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Pick a role/);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("valid body → RPC with caller's own tenant, trimmed lower-case email", async () => {
    const res = await post({ email: "  Deepak@Anutech.in ", role: "support" });
    expect(res.status).toBe(200);
    expect(st.rpcCalls).toEqual([{
      fn: "merge_stranded_user_into_tenant",
      args: { p_email: "deepak@anutech.in", p_tenant_id: "t-1", p_role: "support" },
    }]);
  });

  it("RPC refusal (R-721) → 409 with its text unchanged", async () => {
    st.rpcError = { message: "That person can't be claimed into this workspace." };
    const res = await post({ email: "x@y.in", role: "support" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That person can't be claimed into this workspace.");
  });

  it("deactivated owner → 403, RPC never called (R-722)", async () => {
    st.me = { tenant_id: "t-1", role: "owner", is_active: false };
    const res = await post({ email: "x@y.in", role: "support" });
    expect(res.status).toBe(403);
    expect(st.rpcCalls).toHaveLength(0);
  });
});
