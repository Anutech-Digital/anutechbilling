/**
 * R-1508 (17 Oct 2026, Pawan, staging report fdd10544): signed in, the website kept sending him
 * to the dashboard — "/" and /reselleros redirect a signed-in user unless the URL has ?preview=1,
 * and the site's own Home link has no ?preview=1. So the website could not be tested.
 *
 * Pinned here, the way a request travels:
 *   middleware — a signed-in ?preview=1 visit sets the browser-session cookie; signed out, the
 *                cookie is dropped and never set; the live product-root rewrite sets it too;
 *   pages      — "/" and /reselleros honour the cookie; without it (and without ?preview=1)
 *                they still send a signed-in user to the dashboard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  cookie: undefined as string | undefined,
  host: "localhost:3001",
}));

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/server/auth/middleware-session", () => ({ authjsMiddlewareSession: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }), user: st.user, role: "owner", canViewDeals: true, needsMfa: false,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user } }) } }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: st.host }),
  cookies: async () => ({
    get: (name: string) => (name === "ros_site_preview" && st.cookie !== undefined ? { name, value: st.cookie } : undefined),
  }),
}));
/* The home page reads the live catalogue — no network in a unit test. */
vi.mock("@/site/lib/live-catalog", async (orig) => {
  const real = await orig<typeof import("@/site/lib/live-catalog")>();
  return { ...real, fetchLiveWorkspace: async () => null };
});

import { middleware } from "@/middleware";
import HomePage from "@/app/(marketing)/page";
import ResellerOsHome from "@/app/(product)/reselleros/page";
import { SITE_PREVIEW_COOKIE, hasSitePreviewCookie, isSitePreview, sitePreviewCookieAction } from "@/site/lib/site-preview";

const member = { id: "u1", email: "pawan@anutech.in", app_metadata: {} };

function req(url: string, cookie = "") {
  const host = new URL(url).host;
  return new NextRequest(url, { headers: cookie ? { cookie, host } : { host } });
}

beforeEach(() => { st.user = member; st.cookie = undefined; st.host = "localhost:3001"; });

describe("middleware — website preview cookie (R-1508)", () => {
  it("a signed-in ?preview=1 visit sets a browser-session cookie (no expiry, lax, path /)", async () => {
    const r = await middleware(req("http://localhost:3001/reselleros?preview=1"));
    const c = r.cookies.get(SITE_PREVIEW_COOKIE);
    expect(c?.value).toBe("1");
    expect(c?.path).toBe("/");
    expect(String(c?.sameSite).toLowerCase()).toBe("lax");
    expect(c?.maxAge).toBeUndefined();
    expect(c?.expires).toBeUndefined();
    const raw = r.headers.get("set-cookie") ?? "";
    expect(raw).toContain(`${SITE_PREVIEW_COOKIE}=1`);
    expect(raw.toLowerCase()).not.toContain("max-age");
    expect(raw.toLowerCase()).not.toContain("expires");
  });

  it("a bare visit (no ?preview=1) sets nothing", async () => {
    const r = await middleware(req("http://localhost:3001/"));
    expect(r.cookies.get(SITE_PREVIEW_COOKIE)).toBeUndefined();
  });

  it("signed out: ?preview=1 sets nothing, and an old cookie is dropped", async () => {
    st.user = null;
    expect((await middleware(req("http://localhost:3001/?preview=1"))).cookies.get(SITE_PREVIEW_COOKIE)).toBeUndefined();
    const r = await middleware(req("http://localhost:3001/email", `${SITE_PREVIEW_COOKIE}=1`));
    expect(r.cookies.get(SITE_PREVIEW_COOKIE)?.value).toBe("");
    expect(r.cookies.get(SITE_PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("the live product root (rewritten before the session is read) remembers ?preview=1 too", async () => {
    const r = await middleware(req("https://reselleros.anutech.in/?preview=1"));
    expect(r.headers.get("x-middleware-rewrite")).toContain("/reselleros");
    expect(r.cookies.get(SITE_PREVIEW_COOKIE)?.value).toBe("1");
  });

  it("API calls never touch it", () => {
    expect(sitePreviewCookieAction({ pathname: "/api/x", previewParam: "1", cookieValue: undefined, signedIn: true })).toBe("keep");
    expect(sitePreviewCookieAction({ pathname: "/api/x", previewParam: null, cookieValue: "1", signedIn: false })).toBe("keep");
  });
});

describe("pages honour the preview cookie (R-1508)", () => {
  const home = (preview?: string) => HomePage({ searchParams: Promise.resolve(preview ? { preview } : {}) });
  const product = (preview?: string) => ResellerOsHome({ searchParams: Promise.resolve(preview ? { preview } : {}) });

  it('"/" stays on the website for a signed-in member holding the cookie', async () => {
    st.cookie = "1";
    await expect(home()).resolves.toBeTruthy();
  });

  it('"/" still sends a signed-in member to the dashboard without the cookie or ?preview=1', async () => {
    await expect(home()).rejects.toThrow("REDIRECT /dashboard");
    await expect(home("1")).resolves.toBeTruthy();
  });

  it("/reselleros stays for a signed-in member holding the cookie, redirects without it", async () => {
    st.cookie = "1";
    await expect(product()).resolves.toBeTruthy();
    st.cookie = undefined;
    await expect(product()).rejects.toThrow("REDIRECT /dashboard");
    await expect(product("1")).resolves.toBeTruthy();
  });

  it("a signed-out visitor is never redirected (cookie or not)", async () => {
    st.user = null;
    await expect(home()).resolves.toBeTruthy();
    await expect(product()).resolves.toBeTruthy();
  });

  it("helpers: only the exact value 1 counts", () => {
    expect(isSitePreview("1", undefined)).toBe(true);
    expect(isSitePreview(undefined, "1")).toBe(true);
    expect(isSitePreview("0", "")).toBe(false);
    expect(hasSitePreviewCookie(`a=b; ${SITE_PREVIEW_COOKIE}=1`)).toBe(true);
    expect(hasSitePreviewCookie(`${SITE_PREVIEW_COOKIE}=0; x${SITE_PREVIEW_COOKIE}=1`)).toBe(false);
  });
});
