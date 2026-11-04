/**
 * R-2177 (GP-10c, G-PERSONAL): a personal session goes straight to its money home on the
 * server — /vault/personal — and never renders a business page or the /money hop first.
 *
 * check-2176b (30 Oct 2026, localhost :3005, DATA_GATEWAY=1): a personal login on /dashboard
 * was bounced to /money, and /money is a PAGE whose redirect() streams the whole app shell (HTML
 * 200, NEXT_REDIRECT in the payload) before the browser moves on to /vault/personal: the shell
 * mounted twice and every shell read ran twice. Middleware now answers /dashboard, /login and
 * every refused business URL with ONE 307 to /vault/personal (the denied toast's ?denied rides
 * along), and /money itself is a 307 too. Business roles are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({ role: "personal" as string | null }));

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

const target = (r: Response) => new URL(r.headers.get("location")!);

beforeEach(() => { st.role = "personal"; });

describe("R-2177: a personal session lands on /vault/personal in one server redirect", () => {
  it.each(["/dashboard", "/login", "/login?next=%2Fdashboard", "/signup"])("%s → 307 /vault/personal, no ?denied", async (p) => {
    const r = await go(p);
    expect(r.status).toBe(307);
    expect(target(r).pathname).toBe("/vault/personal");
    expect(target(r).search).toBe("");
  });

  it.each(["/invoices", "/leads", "/settings", "/vault"])("refused %s → /vault/personal?denied=<path>", async (p) => {
    const r = await go(p);
    expect(r.status).toBe(307);
    expect(target(r).pathname).toBe("/vault/personal");
    expect(target(r).searchParams.get("denied")).toBe(p);
  });

  it("/money is a 307 to /vault/personal (no app shell rendered for the hop), keeping its query", async () => {
    const r = await go("/money");
    expect(r.status).toBe(307);
    expect(target(r).pathname).toBe("/vault/personal");
    const q = await go("/money?denied=%2Fleads");
    expect(q.status).toBe(307);
    expect(target(q).pathname).toBe("/vault/personal");
    expect(target(q).searchParams.get("denied")).toBe("/leads");
  });

  it.each(["/vault/personal", "/vault/personal/banking", "/assets", "/support/my", "/upgrade", "/account"])(
    "%s still opens", async (p) => {
      expect((await go(p)).status).toBe(200);
    },
  );
});

describe("R-2177: business roles unchanged", () => {
  it("owner opens /dashboard; owner on /login goes to /dashboard; owner on /money goes to its home", async () => {
    st.role = "owner";
    expect((await go("/dashboard")).status).toBe(200);
    const login = await go("/login");
    expect(target(login).pathname).toBe("/dashboard");
    const money = await go("/money");
    expect(money.status).toBe(307);
    expect(target(money).pathname).toBe("/dashboard");
  });

  it("sales on /login goes to /leads; sales on /money is refused to /leads", async () => {
    st.role = "sales";
    expect(target(await go("/login")).pathname).toBe("/leads");
    const money = await go("/money");
    expect(target(money).pathname).toBe("/leads");
    expect(target(money).searchParams.get("denied")).toBe("/money");
  });
});
