/**
 * R-722: a member the owner deactivated (users.is_active = false) kept a working session —
 * every page and API route answered as before. Now the middleware ends the session on the
 * next request: login cookies cleared, pages → /login?error=deactivated, API → 401.
 *
 * Also pinned: Auth.js's middleware session reports `deactivated` from the users row, and an
 * owner who is deactivated cannot use the owner-only invite route (route.test.ts covers that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  role: "sales" as string | null,
  deactivated: false,
}));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: st.user,
    role: st.role,
    canViewDeals: false,
    needsMfa: false,
    deactivated: st.deactivated,
  }),
}));

import { middleware } from "./middleware";

const SESSION_COOKIES = "__Secure-authjs.session-token=abc; sb-proj-auth-token=xyz; theme=dark";
const go = (path: string, method = "GET") =>
  middleware(new NextRequest(`https://app.test${path}`, { method, headers: { cookie: SESSION_COOKIES } }));

/** Names of the cookies this response expires (max-age 0). */
const cleared = (r: Response) =>
  (r.headers.getSetCookie?.() ?? []).filter((c) => /max-age=0/i.test(c)).map((c) => c.split("=")[0]);

beforeEach(() => { st.user = { id: "u1", app_metadata: {} }; st.role = "sales"; st.deactivated = false; });

describe("middleware — deactivated member is signed out (R-722)", () => {
  it("an active member's request goes through, cookies untouched", async () => {
    const r = await go("/leads");
    expect(r.status).toBe(200);
    expect(cleared(r)).toEqual([]);
  });

  it("deactivate → the NEXT request with the same old session is refused and signed out", async () => {
    expect((await go("/leads")).status).toBe(200);
    st.deactivated = true; // owner switched the member off; the browser still holds its cookie
    const r = await go("/leads");
    expect(r.status).toBe(307);
    const to = new URL(r.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("error")).toBe("deactivated");
    expect(cleared(r).sort()).toEqual(["__Secure-authjs.session-token", "sb-proj-auth-token"]);
  });

  it.each(["/api/leads", "/api/team/invite", "/api/sb/rest/v1/customers", "/api/vault/abc/reveal"])(
    "API %s → 401 with the reason, cookies cleared", async (path) => {
      st.deactivated = true;
      const r = await go(path, "POST");
      expect(r.status).toBe(401);
      const body = await r.json() as { error: string; deactivated: boolean };
      expect(body.deactivated).toBe(true);
      expect(body.error).toMatch(/deactivated/i);
      expect(cleared(r)).toContain("__Secure-authjs.session-token");
    },
  );

  it("an owner/manager is not exempt (no role skips the check)", async () => {
    st.deactivated = true; st.role = "owner";
    expect((await go("/dashboard")).status).toBe(307);
  });

  it("the login page itself renders (no redirect loop) and the cookies are cleared", async () => {
    st.deactivated = true;
    const r = await go("/login?error=deactivated");
    expect(r.status).toBe(200);
    expect(cleared(r)).toContain("__Secure-authjs.session-token");
  });

  it("a signed-out visitor is unaffected", async () => {
    st.user = null; st.deactivated = false;
    const r = await go("/login");
    expect(r.status).toBe(200);
    expect(cleared(r)).toEqual([]);
  });
});
