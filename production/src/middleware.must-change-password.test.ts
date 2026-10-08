/**
 * R-391: a member whose owner set a temporary password is sent to /change-password from
 * every app page (and from /login), keeps the page they asked for as `next`, and is let
 * through once the flag is gone. A signed-out visit to /change-password goes to login.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  role: "sales" as string | null,
}));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
/* R-161 (staging branch) also imports the Auth.js session; stubbed so this file runs there too. */
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: st.user,
    role: st.role,
    canViewDeals: false,
    needsMfa: false,
  }),
}));

import { middleware } from "./middleware";

const go = (path: string) => middleware(new NextRequest(`https://app.test${path}`));
const flagged = { id: "u1", app_metadata: { must_change_password: true } };

beforeEach(() => { st.user = null; st.role = "sales"; });

describe("middleware — forced password change (R-391)", () => {
  it("sends a flagged member from an app page to /change-password with next", async () => {
    st.user = flagged;
    const r = await go("/leads?x=1");
    expect(r.status).toBe(307);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/change-password");
    expect(loc.searchParams.get("next")).toBe("/leads?x=1");
  });

  it("also from /login (instead of the role home)", async () => {
    st.user = flagged;
    const r = await go("/login");
    expect(new URL(r.headers.get("location")!).pathname).toBe("/change-password");
  });

  it("lets the flagged member open /change-password itself", async () => {
    st.user = flagged;
    const r = await go("/change-password");
    expect(r.headers.get("location")).toBeNull();
  });

  it("does nothing once the flag is cleared", async () => {
    st.user = { id: "u1", app_metadata: { must_change_password: null } };
    const r = await go("/leads");
    expect(r.headers.get("location")).toBeNull();
  });

  it("signed out → /change-password goes to login and back", async () => {
    const r = await go("/change-password");
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/change-password");
  });
});
