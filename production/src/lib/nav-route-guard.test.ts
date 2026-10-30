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
  APP_NAV, OFF_MENU_ROLES, ROLE_HOME, ROUTE_DENY, crumbForRole, filterNavForRole, flattenNav, getCrumb, homeForRole, isRouteAllowed,
  type UserRole,
} from "./nav";
import { APP_ROUTES } from "./feedback/route-map";
import { PERSONAL_ONLY_PAGES, PERSONAL_PAGES, isPersonalOnlyPage } from "./workspace/personal-allowlist";
import { buildSidebarApps } from "./nav-apps";

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
/** GP-07a: paths a row in the role's menu also covers (personal Money → /vault/personal). */
const coveredFor = (role: UserRole, p: string) =>
  flattenNav(filterNavForRole(APP_NAV, role)).some((e) => (e.item.covers ?? []).some((c) => under(p, c)));
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
      const want = (menu.has(href) || coveredFor(role, href)) && !denied(role, href);
      if (isRouteAllowed(role, href) !== want) wrong.push(`${href} → ${!want}`);
      const sub = `${href}/__probe`;
      if (isRouteAllowed(role, sub) !== ((menu.has(href) || coveredFor(role, sub)) && !denied(role, sub))) wrong.push(`${sub} → ${!want}`);
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

  it("the owner — whom middleware does not gate — may open every (app) page but the personal-only ones", () => {
    /* GP-07a (R-2115): /money, /assets, /support/my, /upgrade and /account belong to the
       personal workspace. Middleware gates the owner on exactly these (next test). */
    expect(appPages.filter((p) => !isRouteAllowed("owner", p) && !isPersonalOnlyPage(p))).toEqual([]);
  });

  it("middleware sends the owner home (with ?denied) from a personal-only page, and from nothing else", async () => {
    st.role = "owner";
    for (const p of PERSONAL_ONLY_PAGES) {
      expect(isRouteAllowed("owner", p), p).toBe(false);
      const r = await middleware(new NextRequest(`https://app.test${p}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
      expect(r.status, p).toBe(307);
      const to = new URL(r.headers.get("location")!);
      expect(to.pathname, p).toBe("/dashboard");
      expect(to.searchParams.get("denied"), p).toBe(p);
    }
    for (const p of appPages.filter((x) => !isPersonalOnlyPage(x))) {
      const r = await middleware(new NextRequest(`https://app.test${p}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
      expect(r.status, p).toBe(200);
    }
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

/**
 * GP-07a (R-2115, G-PERSONAL measure 2) — a personal login sees ONLY its own pages:
 * Money (/money → /vault/personal/*), My digital assets, Support (/support/my), Upgrade and
 * Account (avatar menu). Every business page — and the company Password Vault at /vault —
 * is refused by the same guard middleware runs.
 */
describe("personal role: only the personal pages (GP-07a)", () => {
  const underAny = (p: string, list: readonly string[]) => list.some((a) => under(p, a));

  it("PERSONAL_PAGES is exactly the agreed list", () => {
    expect([...PERSONAL_PAGES].sort()).toEqual(["/account", "/assets", "/money", "/support/my", "/upgrade", "/vault/personal"]);
  });

  it("walks every (app) page: allowed exactly when it is a personal page", () => {
    const wrong = appPages.filter((p) => isRouteAllowed("personal", p) !== underAny(p, PERSONAL_PAGES));
    expect(wrong).toEqual([]);
  });

  it.each(["/money", "/vault/personal", "/vault/personal/banking", "/vault/personal/expenses", "/vault/personal/wealth", "/assets", "/support/my", "/upgrade", "/account"])(
    "opens %s", (p) => expect(isRouteAllowed("personal", p)).toBe(true),
  );

  it.each(["/dashboard", "/invoices", "/accounting", "/accounting/pnl", "/vault", "/support", "/settings", "/team", "/help", "/today", "/quotes", "/customers"])(
    "refuses %s", (p) => expect(isRouteAllowed("personal", p)).toBe(false),
  );

  it("lands on /money, which it may open — no redirect loop", () => {
    expect(ROLE_HOME.personal).toBe("/money");
    expect(homeForRole("personal")).toBe("/money");
    expect(isRouteAllowed("personal", homeForRole("personal"))).toBe(true);
  });

  it("middleware: a typed business URL goes to /money with ?denied; the personal pages open", async () => {
    st.role = "personal";
    for (const p of ["/invoices", "/settings", "/vault", "/team"]) {
      const r = await middleware(new NextRequest(`https://app.test${p}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
      expect(r.status, p).toBe(307);
      const to = new URL(r.headers.get("location")!);
      expect(to.pathname, p).toBe("/money");
      expect(to.searchParams.get("denied"), p).toBe(p);
    }
    for (const p of ["/money", "/vault/personal", "/vault/personal/banking", "/assets", "/support/my", "/upgrade", "/account"]) {
      const r = await middleware(new NextRequest(`https://app.test${p}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
      expect(r.status, p).toBe(200);
    }
  });

  it("the filtered nav has exactly the 4 rows, in one Personal section", () => {
    const nav = filterNavForRole(APP_NAV, "personal");
    expect(nav.map((s) => s.section)).toEqual(["Personal"]);
    expect(nav[0].items.map((i) => [i.label, i.href])).toEqual([
      ["Money", "/money"], ["My digital assets", "/assets"], ["Support", "/support/my"], ["Upgrade", "/upgrade"],
    ]);
    expect(nav[0].items.every((i) => !i.headerOnly && !i.children?.length && !i.directory?.length)).toBe(true);
  });

  it("the sidebar shows the same 4 rows and nothing pinned", () => {
    const m = buildSidebarApps("personal");
    expect(m.pinned).toEqual([]);
    expect(m.apps.flatMap((a) => a.items.map((i) => i.label))).toEqual(["Money", "My digital assets", "Support", "Upgrade"]);
  });

  /* R-2115 checker: /account read "Home > Dashboard" (no crumb) and /vault/personal read
     "Settings > Password Vault > ..." for a personal login, whose menu has neither. */
  it("/account's breadcrumb is Personal > Account", () => {
    expect(getCrumb("/account")).toEqual(["Personal", "Account"]);
    expect(crumbForRole("/account", "personal")).toEqual(["Personal", "Account"]);
  });

  it.each([
    ["/vault/personal", ["Personal", "Money"]],
    ["/vault/personal/banking", ["Personal", "Money", "Banking"]],
    ["/vault/personal/expenses", ["Personal", "Money", "Expenses"]],
    ["/vault/personal/wealth", ["Personal", "Money", "Wealth"]],
    ["/money", ["Personal", "Money"]],
  ])("a personal login's crumb for %s is %j", (p, crumb) => {
    expect(crumbForRole(p, "personal")).toEqual(crumb);
  });

  it("the owner's Private Vault crumb is unchanged", () => {
    for (const p of ["/vault/personal", "/vault/personal/banking"]) {
      expect(crumbForRole(p, "owner")).toEqual(getCrumb(p));
      expect(crumbForRole(p, undefined)).toEqual(getCrumb(p));
      expect(getCrumb(p)[0]).not.toBe("Personal");
    }
  });

  it("no business role gets a personal row", () => {
    for (const role of ROLES.filter((r) => r !== "personal")) {
      const hrefs = flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href);
      expect(hrefs.filter((h) => underAny(h, PERSONAL_ONLY_PAGES)), role).toEqual([]);
    }
  });
});
