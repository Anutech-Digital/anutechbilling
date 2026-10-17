/**
 * withRoute() — auth, role, zod input, aur sabse zaroori: raw DB error client tak na pahunche.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { id: "U1", email: "a@example.invalid" } as { id: string; email: string } | null,
  me: { tenant_id: "T1", role: "sales" } as { tenant_id: string; role: string } | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.me, error: null }) }) }) }),
  }),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ Sentry: sentry }));

import { withRoute, dbFail, RouteError, mayOpenPage } from "./with-route";

const req = (method: string, body?: unknown, url = "https://x.invalid/api/t") =>
  new Request(url, { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest;

beforeEach(() => {
  state.user = { id: "U1", email: "a@example.invalid" };
  state.me = { tenant_id: "T1", role: "sales" };
  sentry.captureException.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("withRoute", () => {
  it("401 when signed out, handler never runs", async () => {
    state.user = null;
    const h = vi.fn();
    const res = await withRoute({ route: "api/t" }, h)(req("GET"));
    expect(res.status).toBe(401);
    expect(h).not.toHaveBeenCalled();
    expect((await res.json()).ok).toBe(false);
  });

  it("403 with the next step when the user has no workspace", async () => {
    state.me = null;
    const res = await withRoute({ route: "api/t" }, async () => ({}))(req("GET"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner se invite/);
  });

  it("403 when the role is not allowed; passes the tenant and role through when it is", async () => {
    const h = vi.fn(async ({ tenantId, role }: { tenantId: string; role: string }) => ({ tenantId, role }));
    const denied = await withRoute({ route: "api/t", roles: ["owner", "manager"] }, h)(req("POST"));
    expect(denied.status).toBe(403);
    expect(h).not.toHaveBeenCalled();
    state.me = { tenant_id: "T1", role: "manager" };
    const ok = await withRoute({ route: "api/t", roles: ["owner", "manager"] }, h)(req("POST"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, tenantId: "T1", role: "manager" });
  });

  it("R-732: `permission` asks the PERMISSIONS table — 403 unless can(role, permission)", async () => {
    const h = vi.fn(async ({ role }: { role: string }) => ({ role }));
    state.me = { tenant_id: "T1", role: "partner_agent" };
    const denied = await withRoute({ route: "api/t", permission: "can_contact_customers" }, h)(req("POST"));
    expect(denied.status).toBe(403);
    expect(h).not.toHaveBeenCalled();
    state.me = { tenant_id: "T1", role: "sales" };
    const ok = await withRoute({ route: "api/t", permission: "can_contact_customers" }, h)(req("POST"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, role: "sales" });
    // both gates apply when both are given
    const both = await withRoute({ route: "api/t", roles: ["owner"], permission: "can_contact_customers" }, h)(req("POST"));
    expect(both.status).toBe(403);
  });

  it("R-1470: `pages` admits only roles that may open one of those pages (nav.ts rule) — else 403, handler never runs", async () => {
    const h = vi.fn(async ({ role }: { role: string }) => ({ role }));
    const route = withRoute({ route: "api/t", pages: ["/accounting/banking"] }, h);
    state.me = { tenant_id: "T1", role: "sales" };
    expect((await route(req("POST"))).status).toBe(403);
    state.me = { tenant_id: "T1", role: "billing" };
    expect((await route(req("POST"))).status).toBe(200);
    state.me = { tenant_id: "T1", role: "made_up" };
    expect((await route(req("POST"))).status).toBe(403);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("R-1470: mayOpenPage — any one page is enough, ROUTE_DENY wins, unknown role is false", () => {
    expect(mayOpenPage("sales", ["/accounting/banking", "/leads"])).toBe(true);
    expect(mayOpenPage("sales_senior", ["/leads"])).toBe(true);
    expect(mayOpenPage("support", ["/leads"])).toBe(false);
    expect(mayOpenPage("billing", ["/accounting/balance-sheet"])).toBe(false);
    expect(mayOpenPage(null, ["/help"])).toBe(false);
    expect(mayOpenPage("partner_agent", ["/help"])).toBe(true);
  });

  it("validates the body with zod — 400 with the schema's own message", async () => {
    const r = withRoute({ route: "api/t", input: z.object({ id: z.string().min(1, "id chahiye") }) }, async ({ input }) => ({ got: input.id }));
    expect((await r(req("POST", { id: "" }))).status).toBe(400);
    expect((await (await r(req("POST", { id: "" }))).json()).error).toBe("id chahiye");
    expect((await r(req("POST", "{not json"))).status).toBe(400);
    expect(await (await r(req("POST", { id: "abc" }))).json()).toEqual({ ok: true, got: "abc" });
  });

  it("reads GET input from the query string", async () => {
    const r = withRoute({ route: "api/t", input: z.object({ q: z.string() }) }, async ({ input }) => ({ q: input.q }));
    expect(await (await r(req("GET", undefined, "https://x.invalid/api/t?q=hi"))).json()).toEqual({ ok: true, q: "hi" });
  });

  it("never sends raw DB text to the client — logs it with the [route] prefix instead", async () => {
    const raw = 'duplicate key value violates unique constraint "leads_pkey"';
    const r = withRoute({ route: "api/t" }, async () => { dbFail({ message: raw, code: "23505" }, "Save nahi hua — dobara try kariye."); return {}; });
    const res = await r(req("POST"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("leads_pkey");
    expect(body.error).toBe("Save nahi hua — dobara try kariye.");
    expect(body.ref).toMatch(/^[a-z0-9]+$/);
    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/^\[api\/t\] POST failed \([a-z0-9]+\): .*leads_pkey/);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("an unexpected throw is a generic 500 with a ref, not the exception text", async () => {
    const res = await withRoute({ route: "api/t" }, async () => { throw new Error("relation \"secret_table\" does not exist"); })(req("GET"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toContain("secret_table");
    expect(body.error).toContain(body.ref);
  });

  it("RouteError 4xx: author's message and status, logged as warn not error (L6)", async () => {
    const res = await withRoute({ route: "api/t" }, async () => { throw new RouteError(409, "Pehle X karo.", "detail"); })(req("POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "Pehle X karo." });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("passes a plpgsql guard message (P0001) through only when asked", async () => {
    const guard = { message: "Is invoice par payment laga hai — pehle payment hatao.", code: "P0001" };
    const hidden = await withRoute({ route: "api/t" }, async () => { dbFail(guard, "Delete nahi hua."); return {}; })(req("POST"));
    expect((await hidden.json()).error).toBe("Delete nahi hua.");
    const shown = await withRoute({ route: "api/t" }, async () => { dbFail(guard, "Delete nahi hua.", { passGuardMessage: true }); return {}; })(req("POST"));
    expect(shown.status).toBe(409);
    expect((await shown.json()).error).toBe(guard.message);
  });

  it("a Response from the handler is returned untouched", async () => {
    const res = await withRoute({ route: "api/t" }, async () => new Response("x", { status: 202 }))(req("GET"));
    expect(res.status).toBe(202);
  });
});
