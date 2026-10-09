/**
 * R-524: the middleware half of the read-only demo. A demo visitor reads pages, but every
 * write / export gets a 403 with the friendly message; the session ends (cookies cleared) when
 * the ros_demo window is over or DEMO_ENABLED is off. A real user is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({ user: null as Record<string, unknown> | null, role: "manager" as string | null }));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }), user: st.user, role: st.role, canViewDeals: false, needsMfa: false,
  }),
}));

import { middleware } from "./middleware";
import { DEMO_COOKIE, DEMO_REFUSAL, DEMO_VISITOR_EMAIL, demoCookieValue } from "@/lib/demo/demo-account";

const visitor = { id: "v1", email: DEMO_VISITOR_EMAIL, app_metadata: { demo_visitor: true } };

function req(path: string, method = "GET", cookie = `${DEMO_COOKIE}=${demoCookieValue(Date.now())}; sb-local-auth-token=abc`) {
  return new NextRequest(`https://app.test${path}`, { method, headers: { cookie } });
}

beforeEach(() => { st.user = visitor; st.role = "manager"; process.env.DEMO_ENABLED = "1"; });
afterEach(() => { delete process.env.DEMO_ENABLED; });

describe("middleware — demo visitor (R-524)", () => {
  it("reads app pages", async () => {
    const r = await middleware(req("/dashboard"));
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
  });

  it("refuses writes and server actions with the friendly message", async () => {
    for (const [m, p] of [["POST", "/api/invoices"], ["PATCH", "/api/settings"], ["DELETE", "/api/customers/1"], ["POST", "/quotes/new"]] as const) {
      const r = await middleware(req(p, m));
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.headers.get("x-demo-readonly")).toBe("1");
      expect(((await r.json()) as { error: string }).error).toBe(DEMO_REFUSAL);
    }
  });

  it("refuses exports", async () => {
    expect((await middleware(req("/api/invoices/export"))).status).toBe(403);
  });

  it("lets the visitor leave the demo", async () => {
    expect((await middleware(req("/api/demo/end", "POST"))).status).not.toBe(403);
  });

  it("ends the session when the window is over: cookies cleared, back to the homepage", async () => {
    const r = await middleware(req("/dashboard", "GET", "sb-local-auth-token=abc"));
    expect(r.status).toBe(307);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/reselleros");
    expect(loc.searchParams.get("demo")).toBe("ended");
    expect(r.cookies.get("sb-local-auth-token")?.value).toBe("");
  });

  it("ends the session when the owner switches DEMO_ENABLED off", async () => {
    delete process.env.DEMO_ENABLED;
    const r = await middleware(req("/api/customers"));
    expect(r.status).toBe(401);
  });

  it("a real user's writes are not touched", async () => {
    st.user = { id: "u1", email: "owner@anutech.in", app_metadata: {} };
    const r = await middleware(req("/api/invoices", "POST", ""));
    expect(r.status).not.toBe(403);
  });
});
