/**
 * R-524: /api/demo/session — off by default, rate-limited, never swaps a real user's session,
 * and FAILS CLOSED: if the database does not confirm the session is read-only, the visitor is
 * signed straight out and no demo cookie is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  current: null as null | { id: string; email: string },
  demo: { tenant_id: "t-demo", visitor_user_id: "v1", seeder_user_id: "s1" } as null | { tenant_id: string; visitor_user_id: string; seeder_user_id: string },
  signedAs: "v1" as string | null,
  wall: true,
  rateOk: true,
  signOut: vi.fn(async (_o?: { scope: string }) => ({ error: null })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.current } }), signOut: st.signOut } }),
  createAdminClient: () => ({}),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: () => "1.2.3.4",
  rateLimitShared: async () => ({ ok: st.rateOk, retryAfterSec: 60 }),
}));
vi.mock("@/lib/demo/demo-account.server", () => ({
  getDemoTenant: async () => st.demo,
  signInAs: async () => (st.signedAs ? { ok: true, userId: st.signedAs } : { ok: false, error: "no" }),
  readOnlyWallUp: async () => st.wall,
}));

import { POST } from "./route";

const call = () => POST(new Request("https://reselleros.anutech.in/api/demo/session", {
  method: "POST", headers: { host: "reselleros.anutech.in", "x-forwarded-proto": "https" },
}));

beforeEach(() => {
  process.env.DEMO_ENABLED = "1";
  Object.assign(st, { current: null, demo: { tenant_id: "t-demo", visitor_user_id: "v1", seeder_user_id: "s1" }, signedAs: "v1", wall: true, rateOk: true });
  st.signOut.mockClear();
});
afterEach(() => { delete process.env.DEMO_ENABLED; });

describe("POST /api/demo/session", () => {
  it("opens the demo: 303 to /dashboard with a short-lived ros_demo cookie", async () => {
    const r = await call();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://reselleros.anutech.in/dashboard");
    expect(r.headers.get("set-cookie")).toMatch(/ros_demo=\d+;.*Max-Age=3600/i);
  });

  it("does nothing while DEMO_ENABLED is off", async () => {
    delete process.env.DEMO_ENABLED;
    const r = await call();
    expect(r.headers.get("location")).toBe("https://reselleros.anutech.in/?demo=off");
  });

  it("rate-limited per IP", async () => {
    st.rateOk = false;
    expect((await call()).headers.get("location")).toMatch(/\?demo=busy$/);
  });

  it("FAILS CLOSED when the database does not confirm read-only", async () => {
    st.wall = false;
    const r = await call();
    expect(r.headers.get("location")).toMatch(/\?demo=unavailable$/);
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/ros_demo=\d/);
    expect(st.signOut).toHaveBeenCalledWith({ scope: "local" }); // never "global": that would kick every other demo visitor out
  });

  it("refuses when the demo workspace is not set up yet, or the login is not the registered visitor", async () => {
    st.demo = null;
    expect((await call()).headers.get("location")).toMatch(/\?demo=unavailable$/);
    st.demo = { tenant_id: "t-demo", visitor_user_id: "v1", seeder_user_id: "s1" };
    st.signedAs = "someone-else";
    expect((await call()).headers.get("location")).toMatch(/\?demo=unavailable$/);
    expect(st.signOut).toHaveBeenCalled();
  });

  it("never swaps a real signed-in user's session", async () => {
    st.current = { id: "u1", email: "owner@anutech.in" };
    const r = await call();
    expect(r.headers.get("location")).toBe("https://reselleros.anutech.in/dashboard");
    expect(r.headers.get("set-cookie") ?? "").not.toMatch(/ros_demo=/);
  });
});
