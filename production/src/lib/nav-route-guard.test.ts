/**
 * R-1542 (18 Oct 2026) — ONE rule for "may this role open this page": the menu.
 *
 * The URL guard (isRouteAllowed → middleware, and mayOpenPage → API routes) matched by prefix,
 * so a parent row the role could see admitted every child row it could not: billing and the
 * accountant opened Parent Accounts, the Profit report and SaaS metrics by typing the URL;
 * billing opened owner-only Backup through "/settings". Middleware also skipped the manager, so
 * ROUTE_DENY.manager never ran.
 *
 * Pinned here, for every role:
 *   1. a menu row opens by URL exactly when it is in that role's menu — and so does a sub-page
 *      under it that is not itself a row;
 *   2. every (app) page is under a menu row or listed in OFF_MENU_ROLES with its roles;
 *   3. middleware enforces that same answer on every (app) page (none missing from its list);
 *   4. the owner, whom middleware does not gate, may open every page anyway.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  APP_NAV, OFF_MENU_ROLES, ROLE_HOME, ROUTE_DENY, filterNavForRole, flattenNav, isRouteAllowed,
  type UserRole,
} from "./nav";
import { APP_ROUTES } from "./feedback/route-map";

const st = vi.hoisted(() => ({ role: "sales" as string | null }));
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
const under = (p: string, a: string) => p === a || p.startsWith(a + "/");
const denied = (role: UserRole, p: string) => (ROUTE_DENY[role] ?? []).some((d) => under(p, d));
const allHrefs = [...new Set(flattenNav(APP_NAV).map((e) => e.item.href))];
const menuOf = (role: UserRole) => new Set(flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href));
/** Every (app) page, with a sample value in each [param]. */
const appPages = APP_ROUTES.filter((r) => r.file.includes("/(app)/")).map((r) => r.route.replace(/\[[^\]]+\]/g, "x"));

describe("URL access = the menu (R-1542)", () => {
  it("every menu row has its own roles", () => {
    const bare = flattenNav(APP_NAV).filter((e) => !e.item.roles?.length).map((e) => e.item.href);
    expect(bare).toEqual([]);
  });

  it.each(ROLES)("%s: a menu row (and a sub-page under it) opens by URL exactly when it is in the menu", (role) => {
    const menu = menuOf(role);
    const wrong: string[] = [];
    for (const href of allHrefs) {
      const want = menu.has(href) && !denied(role, href);
      if (isRouteAllowed(role, href) !== want) wrong.push(`${href} → ${!want}`);
      const sub = `${href}/__probe`;
      if (isRouteAllowed(role, sub) !== (menu.has(href) && !denied(role, sub))) wrong.push(`${sub} → ${!want}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every (app) page is under a menu row or in OFF_MENU_ROLES", () => {
    const orphans = appPages.filter((p) => !allHrefs.some((h) => under(p, h)) && !Object.keys(OFF_MENU_ROLES).some((k) => under(p, k)));
    expect(orphans, "give the page a menu row (nav.ts) or an OFF_MENU_ROLES entry").toEqual([]);
  });

  it("OFF_MENU_ROLES has no stale entries", () => {
    for (const k of Object.keys(OFF_MENU_ROLES)) {
      expect(appPages.some((p) => under(p, k)), `${k} is no longer a page`).toBe(true);
      expect(allHrefs.some((h) => under(k, h)), `${k} is under a menu row now — remove it`).toBe(false);
    }
  });

  it("the owner — whom middleware does not gate — may open every (app) page", () => {
    expect(appPages.filter((p) => !isRouteAllowed("owner", p))).toEqual([]);
  });

  it("every role's home opens for it (no redirect loop)", () => {
    for (const role of ROLES) expect(isRouteAllowed(role, ROLE_HOME[role]), role).toBe(true);
  });

  it.each(ROLES.filter((r) => r !== "owner"))("%s: middleware gives every (app) page the same answer", async (role) => {
    st.role = role;
    const wrong: string[] = [];
    for (const p of appPages) {
      const r = await middleware(new NextRequest(`https://app.test${p}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
      const opened = r.status === 200;
      if (opened !== isRouteAllowed(role, p)) wrong.push(`${p} status ${r.status}`);
    }
    expect(wrong).toEqual([]);
  });
});
