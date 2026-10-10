/**
 * R-710: updateSession reports "could not check" instead of throwing or claiming "signed out".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  getUser: async (): Promise<unknown> => ({ data: { user: null }, error: null }),
  usersRead: async (): Promise<unknown> => ({ data: { role: "sales", can_view_deals: false }, error: null }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: () => st.getUser(),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) },
    },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: () => st.usersRead() };
      return q;
    },
  }),
}));

import { updateSession } from "./middleware";

const req = () => new NextRequest("https://reselleros.anutech.in/dashboard");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://api.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});

describe("updateSession (R-710)", () => {
  it("a thrown fetch failure becomes authUnreachable, not an exception", async () => {
    st.getUser = async () => { throw new TypeError("fetch failed"); };
    const s = await updateSession(req());
    expect(s.authUnreachable).toBe(true);
    expect(s.user).toBeNull();
  });

  it("auth-js's AuthRetryableFetchError (returned, not thrown) is also unreachable", async () => {
    st.getUser = async () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    const s = await updateSession(req());
    expect(s.authUnreachable).toBe(true);
  });

  it("a plain missing session is signed out, not an outage", async () => {
    st.getUser = async () => ({ data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 } });
    const s = await updateSession(req());
    expect(s.authUnreachable).toBe(false);
    expect(s.user).toBeNull();
  });

  it("an unreachable role lookup is reported, never read as 'no role' (which skips the role guard)", async () => {
    st.getUser = async () => ({ data: { user: { id: "u1" } }, error: null });
    st.usersRead = async () => ({ data: null, error: { message: "TypeError: fetch failed", details: "UND_ERR_CONNECT_TIMEOUT", code: "" } });
    const s = await updateSession(req());
    expect(s.authUnreachable).toBe(true);
    expect(s.role).toBeNull();
  });

  it("signed in + role read normally", async () => {
    st.getUser = async () => ({ data: { user: { id: "u1" } }, error: null });
    st.usersRead = async () => ({ data: { role: "sales", can_view_deals: true }, error: null });
    const s = await updateSession(req());
    expect(s.authUnreachable).toBe(false);
    expect(s.role).toBe("sales");
    expect(s.canViewDeals).toBe(true);
  });
});
