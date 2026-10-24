/**
 * R-1810 (R-1648 leftover, 24 Oct 2026): a role that types a URL it cannot open was bounced to
 * its home with no word why — billing typed /accounting/balance-sheet and simply landed on
 * /invoices. The redirect now carries ?denied=<the path it asked for>, and the app shell
 * (components/layout/denied-route-toast.tsx) turns that into "You don't have access to …".
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({ role: "billing" as string | null }));

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

describe("R-1810 — the role-guard redirect says which page was refused", () => {
  it("billing typing /accounting/balance-sheet lands on /invoices?denied=/accounting/balance-sheet", async () => {
    st.role = "billing";
    const r = await go("/accounting/balance-sheet?from=2026-04-01");
    expect(r.status).toBe(307);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/invoices");
    expect(loc.searchParams.get("denied")).toBe("/accounting/balance-sheet");
    // The refused page's own query is not carried onto the home page.
    expect(loc.searchParams.get("from")).toBeNull();
  });

  it("an allowed page is not redirected", async () => {
    st.role = "billing";
    const r = await go("/invoices");
    expect(r.status).toBe(200);
  });
});
