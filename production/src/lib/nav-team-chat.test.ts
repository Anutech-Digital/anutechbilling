/**
 * R-2300 (G-TEAMCHAT TC-07): Team chat is a real menu row now, not an OFF_MENU_ROLES page.
 *
 * The same people as chat_is_staff() (R-2294) see it and may open it by URL: every staff role
 * (sales_senior counts as sales). The external partner agent and the free personal login never
 * see the row, and both the route guard and middleware send them home from /team-chat.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { APP_NAV, NOT_IN_NAV, OFF_MENU_ROLES, ROLE_HOME, filterNavForRole, flattenNav, isRouteAllowed, type UserRole } from "./nav";
import { NAV_APPS, buildSidebarApps } from "./nav-apps";

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

const STAFF_ROLES: UserRole[] = ["owner", "manager", "sales", "sales_senior", "billing", "delivery", "accountant", "support", "marketing"];
const OUTSIDE_ROLES: UserRole[] = ["partner_agent", "personal"];
const menuHrefs = (role: UserRole) => flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href);

async function middlewareFor(role: UserRole, path: string) {
  st.role = role;
  return middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie: "sb-proj-auth-token=xyz" } }));
}

describe("Team chat menu row (R-2300)", () => {
  it("covers every role the app knows (no role left undecided)", () => {
    expect([...STAFF_ROLES, ...OUTSIDE_ROLES].sort()).toEqual((Object.keys(ROLE_HOME) as UserRole[]).sort());
  });

  it.each(STAFF_ROLES)("%s sees 'Team chat' in the menu and may open it", (role) => {
    const row = flattenNav(filterNavForRole(APP_NAV, role)).find((e) => e.item.href === "/team-chat");
    expect(row?.item.label).toBe("Team chat");
    expect(isRouteAllowed(role, "/team-chat")).toBe(true);
  });

  it.each(OUTSIDE_ROLES)("%s does not see it and the route guard refuses it", (role) => {
    expect(menuHrefs(role)).not.toContain("/team-chat");
    expect(isRouteAllowed(role, "/team-chat")).toBe(false);
  });

  it.each(OUTSIDE_ROLES)("%s: middleware sends a typed /team-chat URL home", async (role) => {
    const r = await middlewareFor(role, "/team-chat");
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).not.toBe("/team-chat");
  });

  it.each(STAFF_ROLES.filter((r) => r !== "owner"))("%s: middleware lets /team-chat through", async (role) => {
    const r = await middlewareFor(role, "/team-chat");
    expect(r.status).toBe(200);
  });

  it("the temporary R-2299 off-menu entries are gone", () => {
    expect(OFF_MENU_ROLES["/team-chat"]).toBeUndefined();
    expect(NOT_IN_NAV["/team-chat"]).toBeUndefined();
  });

  it("sits in the Team app of the sidebar, with its own chat icon (not AI Help's 'message')", () => {
    const team = NAV_APPS.find((a) => a.id === "team");
    expect(team?.itemIds).toContain("team-chat");
    const row = flattenNav(APP_NAV).find((e) => e.item.href === "/team-chat");
    expect(row?.section.section).toBe("Team");
    expect(row?.item.icon).toBe("chat");
    expect(buildSidebarApps("accountant").apps.find((a) => a.id === "team")?.items.map((i) => i.id)).toContain("team-chat");
  });
});
