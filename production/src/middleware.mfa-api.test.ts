/**
 * R-701: two-factor is on and the code has not been entered yet (aal1, nextLevel aal2).
 * Pages already go to /mfa (R-048); the API used to answer as if the login were complete,
 * so a stolen password alone could invite an owner, reset a member's password or reveal a
 * vault secret. Now every /api route answers 401 until the code is given — except the
 * routes that never use the session (public, webhooks, cron, health) and the pre-login
 * auth routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  role: "owner" as string | null,
  needsMfa: false,
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
    needsMfa: st.needsMfa,
  }),
}));

import { middleware } from "./middleware";

const go = (path: string, method = "POST") => middleware(new NextRequest(`https://app.test${path}`, { method }));

beforeEach(() => { st.user = { id: "u1", app_metadata: {} }; st.role = "owner"; st.needsMfa = true; });

describe("middleware — two-factor on the API (R-701)", () => {
  it.each([
    "/api/team/invite",
    "/api/team/members/abc/temp-password",
    "/api/vault/abc/reveal",
    "/api/platform/signups/abc",
    "/api/settings/reset-data",
    "/api/auth/onboarding/new-tenant",
  ])("refuses %s before the code is entered", async (path) => {
    const r = await go(path);
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.error).toMatch(/code/i);
  });

  it("refuses a GET too (reads leak as much as writes)", async () => {
    const r = await go("/api/vault", "GET");
    expect(r.status).toBe(401);
  });

  it.each([
    "/api/public/catalog/workspace",
    "/api/webhooks/razorpay",
    "/api/cron/renewals",
    "/api/health/money",
    "/api/version",
    "/api/auth/signup",
    "/api/auth/verify-email",
    "/api/auth/resend-verification",
  ])("lets %s through (it does not rely on the session)", async (path) => {
    const r = await go(path);
    expect(r.status).not.toBe(401);
  });

  it("lets the API through once the code is entered", async () => {
    st.needsMfa = false;
    const r = await go("/api/team/invite");
    expect(r.status).not.toBe(401);
  });

  it("does not touch signed-out API calls (each route answers for itself)", async () => {
    st.user = null;
    const r = await go("/api/team/invite");
    expect(r.status).not.toBe(401);
  });

  it("still sends pages to /mfa", async () => {
    const r = await go("/leads", "GET");
    expect(new URL(r.headers.get("location")!).pathname).toBe("/mfa");
  });
});
