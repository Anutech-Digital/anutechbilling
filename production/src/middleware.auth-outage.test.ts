/**
 * R-710: 9 Oct 2026, 12:03–12:06 IST — api.anutech.in did not answer and the middleware
 * threw on every request (65 × 5xx, public pages too). Now: public pages and session-free
 * APIs carry on signed-out, app pages get a self-reloading 503, session APIs a 503 JSON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({ mode: "throw" as "throw" | "unreachable" | "ok" }));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => {
    if (st.mode === "throw") throw new TypeError("fetch failed");
    return {
      response: NextResponse.next({ request }),
      user: st.mode === "ok" ? { id: "u1", app_metadata: {} } : null,
      role: st.mode === "ok" ? "owner" : null,
      canViewDeals: false,
      needsMfa: false,
      authUnreachable: st.mode === "unreachable",
    };
  },
}));

import { middleware } from "./middleware";

const go = (path: string, method = "GET") =>
  middleware(new NextRequest(`https://reselleros.anutech.in${path}`, { method }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each(["throw", "unreachable"] as const)("middleware — auth server unreachable (%s)", (mode) => {
  beforeEach(() => { st.mode = mode; });

  it.each(["/buy/workspace", "/login", "/quote/abc/accept"])("public page %s renders signed-out, no 5xx", async (path) => {
    const r = await go(path);
    expect(r.status).toBeLessThan(500);
    expect(r.headers.get("location")).toBeNull();
  });

  it.each(["/api/public/catalog/workspace", "/api/cron/gmail-inbox", "/api/webhooks/razorpay", "/api/health/money"])(
    "session-free API %s still runs",
    async (path) => {
      const r = await go(path);
      expect(r.status).toBeLessThan(500);
    },
  );

  it("an app page gets a self-reloading 503, not a bounce to /login", async () => {
    const r = await go("/dashboard");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.get("location")).toBeNull();
    const html = await r.text();
    expect(html).toContain('http-equiv="refresh"');
  });

  it("a session API answers 503 JSON with retryable:true", async () => {
    const r = await go("/api/team/invite", "POST");
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.retryable).toBe(true);
  });
});

describe("middleware — auth reachable", () => {
  it("behaves as before for a signed-in owner", async () => {
    st.mode = "ok";
    const r = await go("/dashboard");
    expect(r.status).toBe(200);
  });
});
