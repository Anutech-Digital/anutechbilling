/**
 * R-1440 (16 Oct 2026): a Sales user opened /referrals and /provisioning. The role guard in
 * middleware only runs for paths in PROTECTED_PREFIXES, and those two (plus /documents,
 * /hosting-domains, /my-expenses) were never added — so the nav's `roles` said "owner +
 * manager" and nothing enforced it on a typed URL.
 *
 * The broad check below walks EVERY menu page: a role the nav does not admit must be bounced
 * to its home. A new menu row whose prefix is missing from PROTECTED_PREFIXES fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { APP_NAV, flattenNav, isRouteAllowed, ROLE_HOME, type UserRole } from "@/lib/nav";

const st = vi.hoisted(() => ({ role: "sales" as string | null }));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: { id: "u1", app_metadata: {} },
    role: st.role,
    canViewDeals: false,
    needsMfa: false,
    deactivated: false,
  }),
}));

import { middleware } from "./middleware";

const go = (path: string) =>
  middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));

beforeEach(() => { st.role = "sales"; });

describe("middleware role guard — Referrals and Provisioning (R-1440)", () => {
  it.each(["/referrals", "/referrals/anything", "/provisioning", "/provisioning/x/y"])(
    "sales on %s → bounced to /leads", async (path) => {
      const r = await go(path);
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname).toBe("/leads");
    },
  );

  it.each(["sales_senior", "billing", "accountant", "partner_agent"])(
    "%s cannot open /referrals either", async (role) => {
      st.role = role;
      const r = await go("/referrals");
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname).toBe(ROLE_HOME[role as UserRole]);
    },
  );

  it.each(["owner", "manager"])("%s still opens both pages", async (role) => {
    st.role = role;
    expect((await go("/referrals")).status).toBe(200);
    expect((await go("/provisioning")).status).toBe(200);
  });

  it("support and delivery still open the Activation Queue (their menu row)", async () => {
    for (const role of ["support", "delivery"]) {
      st.role = role;
      expect((await go("/provisioning")).status).toBe(200);
    }
  });
});

/* R-1528 (17 Oct 2026): a senior seller works the same customers' money as a seller, so Payment
   Follow-up (/collections) must open for sales_senior wherever it opens for sales. nav.ts gives
   it through filterNavForRole (sales_senior sees what sales sees) — this pins it on a typed URL. */
describe("middleware role guard — Payment Follow-up (R-1528)", () => {
  it.each(["owner", "manager", "billing", "accountant", "sales", "sales_senior"])(
    "%s opens /collections", async (role) => {
      st.role = role;
      expect((await go("/collections")).status).toBe(200);
      expect(isRouteAllowed(role as UserRole, "/collections")).toBe(true);
    },
  );

  it.each(["support", "delivery", "partner_agent"])("%s is bounced from /collections to its home", async (role) => {
    st.role = role;
    const r = await go("/collections");
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe(ROLE_HOME[role as UserRole]);
  });
});

describe("middleware role guard — every menu page is enforced (R-1440)", () => {
  const roles = Object.keys(ROLE_HOME).filter((r) => r !== "owner" && r !== "manager") as UserRole[];
  const hrefs = [...new Set(flattenNav(APP_NAV).map((e) => e.item.href.split(/[?#]/)[0]))];

  it.each(roles)("%s is bounced from every menu page the nav does not give it", async (role) => {
    st.role = role;
    const leaks: string[] = [];
    for (const href of hrefs) {
      if (isRouteAllowed(role, href, { canViewDeals: false })) continue;
      const r = await go(href);
      if (r.status !== 307) leaks.push(href);
    }
    expect(leaks).toEqual([]);
  });
});
