/**
 * R-1103: staging and live run AUTH_PROVIDER=authjs. This pins R-722's sign-out on THAT path,
 * end to end: the real src/middleware.ts → the real authjsMiddlewareSession() → the users row
 * (role, can_view_deals, is_active) read with the user's own rights (users_self_read).
 * Only Auth.js's auth() and the database answer are faked.
 *
 *   deactivated (is_active = false) → cookies cleared + /login?error=deactivated, API 401
 *   active member                   → unchanged
 *   no users row (new signup)       → NOT treated as deactivated
 *   /login itself                   → renders (no redirect loop), cookies cleared
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async () => { throw new Error("GoTrue path must not run with AUTH_PROVIDER=authjs"); },
}));
vi.mock("@/server/auth/authjs", () => ({ auth: async () => st.session }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "users" ? st.row : null, error: null });
      return q;
    },
  }),
}));

const prevProvider = process.env.AUTH_PROVIDER;
process.env.AUTH_PROVIDER = "authjs";
afterAll(() => { process.env.AUTH_PROVIDER = prevProvider; });

import { middleware } from "./middleware";

const COOKIES = "__Secure-authjs.session-token=abc; theme=dark";
const go = (path: string, method = "GET") =>
  middleware(new NextRequest(`https://app.test${path}`, { method, headers: { cookie: COOKIES } }));
const cleared = (r: Response) =>
  (r.headers.getSetCookie?.() ?? []).filter((c) => /max-age=0/i.test(c)).map((c) => c.split("=")[0]);

beforeEach(() => {
  process.env.AUTH_PROVIDER = "authjs";
  st.session = { user: { id: "u1", email: "m@x.test" }, aal: "aal1", mfaEnrolled: false };
  st.row = { role: "sales", can_view_deals: false, is_active: true };
});

describe("middleware on Auth.js — deactivated member is signed out (R-1103 / R-722)", () => {
  it("active member: page goes through, cookies untouched", async () => {
    const r = await go("/leads");
    expect(r.status).toBe(200);
    expect(cleared(r)).toEqual([]);
  });

  it("deactivated member: page → /login?error=deactivated, Auth.js cookie cleared", async () => {
    st.row = { role: "sales", can_view_deals: false, is_active: false };
    const r = await go("/leads");
    expect(r.status).toBe(307);
    const to = new URL(r.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("error")).toBe("deactivated");
    expect(cleared(r)).toEqual(["__Secure-authjs.session-token"]);
  });

  it("deactivated member: API → 401, Auth.js cookie cleared", async () => {
    st.row = { role: "owner", can_view_deals: true, is_active: false };
    const r = await go("/api/leads", "POST");
    expect(r.status).toBe(401);
    expect(((await r.json()) as { deactivated: boolean }).deactivated).toBe(true);
    expect(cleared(r)).toEqual(["__Secure-authjs.session-token"]);
  });

  it("deactivated member on /login: renders (no loop), cookie cleared", async () => {
    st.row = { role: "sales", can_view_deals: false, is_active: false };
    const r = await go("/login?error=deactivated");
    expect(r.status).toBe(200);
    expect(cleared(r)).toEqual(["__Secure-authjs.session-token"]);
  });

  it("missing users row is not treated as deactivated", async () => {
    st.row = null;
    const r = await go("/api/leads", "POST");
    expect(r.status).not.toBe(401);
    expect(cleared(r)).toEqual([]);
  });

  it("is_active null (unknown) is not treated as deactivated", async () => {
    st.row = { role: "sales", can_view_deals: false, is_active: null };
    const r = await go("/leads");
    expect(r.status).toBe(200);
    expect(cleared(r)).toEqual([]);
  });
});
