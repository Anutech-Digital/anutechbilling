/**
 * R-1837 (24 Oct 2026): a marketing user signed in and landed on
 * /marketing?denied=%2Fdashboard — "You don't have access" was the first thing they saw,
 * because login (and "/", and every "Back to dashboard" link) goes to /dashboard and the
 * guard treated that as a typed URL. Each role now lands on its first allowed page
 * (homeForRole, decided by isRouteAllowed) with no ?denied; R-1810's toast stays for a
 * page the user really asked for.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { ROLE_HOME, homeForRole, isRouteAllowed, type UserRole } from "./nav";

const st = vi.hoisted(() => ({ role: "marketing" as string | null }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: { id: "u1", app_metadata: {} },
    role: st.role, canViewDeals: false, needsMfa: false, deactivated: false,
  }),
}));
import { middleware } from "../middleware";

const ROLES = Object.keys(ROLE_HOME) as UserRole[];
/* R-2177: middleware sends a personal login past its /money row (a page that only forwards)
   straight to /vault/personal; every other role lands on homeForRole itself. */
const serverHome = (role: UserRole) => (homeForRole(role) === "/money" ? "/vault/personal" : homeForRole(role));
const go = async (role: UserRole, path: string) => {
  st.role = role;
  const r = await middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
  const loc = r.headers.get("location");
  return { status: r.status, to: loc ? new URL(loc) : null };
};

describe("role home (R-1837)", () => {
  it.each(ROLES)("%s: homeForRole is a page the role may open", (role) => {
    expect(isRouteAllowed(role, homeForRole(role)), homeForRole(role)).toBe(true);
  });

  it("marketing lands on the Marketing Hub", () => {
    expect(homeForRole("marketing")).toBe("/marketing");
  });

  it("falls back to the first page of the role's own menu when ROLE_HOME is not allowed", () => {
    const saved = ROLE_HOME.marketing;
    try {
      ROLE_HOME.marketing = "/settings/backup"; // owner-only — marketing may not open it
      const home = homeForRole("marketing");
      expect(home).not.toBe("/settings/backup");
      expect(isRouteAllowed("marketing", home)).toBe(true);
    } finally {
      ROLE_HOME.marketing = saved;
    }
  });

  it.each(ROLES.filter((r) => r !== "owner"))("%s: after login (/login while signed in) → home, no ?denied", async (role) => {
    const { status, to } = await go(role, "/login");
    expect(status).toBe(307);
    expect(to?.pathname).toBe(serverHome(role));
    expect(to?.searchParams.has("denied")).toBe(false);
  });

  it.each(ROLES.filter((r) => r !== "owner" && !isRouteAllowed(r, "/dashboard")))(
    "%s: /dashboard (login default, \"/\", Back to dashboard) → home, no ?denied",
    async (role) => {
      const { status, to } = await go(role, "/dashboard");
      expect(status).toBe(307);
      expect(to?.pathname).toBe(serverHome(role));
      expect(to?.searchParams.has("denied")).toBe(false);
    },
  );

  it("a really blocked URL still says so (R-1810)", async () => {
    const { status, to } = await go("marketing", "/invoices");
    expect(status).toBe(307);
    expect(to?.pathname).toBe("/marketing");
    expect(to?.searchParams.get("denied")).toBe("/invoices");
  });

  it("marketing opens its home directly (no redirect)", async () => {
    const { status } = await go("marketing", "/marketing");
    expect(status).toBe(200);
  });
});
