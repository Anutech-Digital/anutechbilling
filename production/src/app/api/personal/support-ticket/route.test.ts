/**
 * R-2176 — POST /api/personal/support-ticket: the caller's OWN session files the ticket. No
 * service-role client is made (under DATA_GATEWAY=1 that is app_service, which cannot read
 * public.users — the localhost check of 4957282b0), and the request names no user, tenant or
 * customer: personal_file_support_ticket reads auth.uid().
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUser, rpc } = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser }, rpc }),
  createAdminClient: () => { throw new Error("service role must not be used"); },
  createAdminClientFor: () => { throw new Error("service role must not be used"); },
}));

import { POST } from "./route";

const req = (body: unknown) => new Request("http://x/api/personal/support-ticket", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => { getUser.mockReset(); rpc.mockReset(); });

describe("POST /api/personal/support-ticket (R-2176)", () => {
  it("not signed in → 401, nothing filed", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(req({ text: "hi" }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("files through the SESSION client's rpc; ids in the body are ignored", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    rpc.mockResolvedValue({ data: "TKT-ABC-01", error: null });
    const res = await POST(req({ text: "Broken", type: "bug", severity: "high", pagePath: "/assets", userId: "someone-else", tenantId: "t" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticketId: "TKT-ABC-01" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("personal_file_support_ticket");
    expect(JSON.stringify(args)).not.toMatch(/someone-else|"t"/);
    expect(args).toMatchObject({ p_category: "tech", p_priority: "high" });
  });

  it("unknown kind/severity fall back to bug/medium; over-long text is refused before the call", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    rpc.mockResolvedValue({ data: "T", error: null });
    await POST(req({ text: "x", type: "hack", severity: "nope" }));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_category: "tech", p_priority: "normal" });
    rpc.mockClear();
    expect((await POST(req({ text: "x".repeat(9000) }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a SQL refusal keeps its status and the honest message", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "me" } } });
    rpc.mockResolvedValue({ data: null, error: { message: "R2176_NOT_LINKED: no support desk is linked to this login yet." } });
    const res = await POST(req({ text: "x" }));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe("NOT_LINKED");
    expect(j.error).toMatch(/NOT sent/);
    rpc.mockResolvedValue({ data: null, error: { message: "R2176_NOT_PERSONAL: this is for personal accounts." } });
    expect((await POST(req({ text: "x" }))).status).toBe(403);
  });

  it("the route source holds no service role", () => {
    const src = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/createAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  });
});
