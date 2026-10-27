/**
 * R-1926 (G-ONBOARD OB-5): the confirm link signs a NEW OWNER in and sends them to setup.
 *
 * Owner's real path: sign up with email + password → open "Confirm my email" from the mail →
 * land on /setup?welcome=1, already signed in, without typing the password again (the Google
 * door already ends there: welcome/page.tsx). Before this card the route only confirmed the
 * address and the page said "Sign in".
 *
 * Never weaker: no session for a bad / used / expired token, none for a person parked on a
 * join request (no workspace of their own yet), none for an address with no profile.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const st = vi.hoisted(() => ({
  confirm: { ok: true, email: "asha@rao-traders.in", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as Record<string, unknown>,
  routed: null as { tenantName: string } | null,
  userRow: null as Record<string, unknown> | null,
  tenantRow: null as Record<string, unknown> | null,
  sessionOk: true,
  sessionCalls: [] as Array<{ userId: string; email: string }>,
}));

vi.mock("@/lib/app-url", () => ({ trustedOrigin: () => "http://localhost:3001" }));
vi.mock("@/lib/auth/email-verification", () => ({ confirmEmailToken: async () => st.confirm }));
vi.mock("@/lib/auth/tenant-match", () => ({ routeVerifiedSignupToCompany: async () => st.routed }));
vi.mock("@/server/auth/email-link", () => ({
  startSessionAfterVerify: async (a: { userId: string; email: string }) => { st.sessionCalls.push(a); return st.sessionOk; },
}));
vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.eq = () => self;
    self.maybeSingle = async () => ({ data: table === "users" ? st.userRow : table === "tenants" ? st.tenantRow : null, error: null });
    return self;
  };
  return {
    createAdminClient: () => ({
      from: (t: string) => chain(t),
      auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: { full_name: "Asha Rao" } } } }) } },
    }),
  };
});

import { POST } from "./route";

let ip = 0;
const post = (token = "x".repeat(43)) =>
  POST(new NextRequest("http://localhost:3001/api/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` },
    body: JSON.stringify({ token }),
  }));

beforeEach(() => {
  st.confirm = { ok: true, email: "asha@rao-traders.in", userId: UID };
  st.routed = null;
  st.userRow = { id: UID, tenant_id: TENANT, role: "owner" };
  st.tenantRow = { id: TENANT, setup_completed_at: null };
  st.sessionOk = true;
  st.sessionCalls = [];
});

describe("R-1926 confirm link → signed in → setup", () => {
  it("a new owner (setup not finished) is signed in and sent to /setup?welcome=1", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, email: "asha@rao-traders.in", signedIn: true, next: "/setup?welcome=1" });
    expect(st.sessionCalls).toEqual([{ userId: UID, email: "asha@rao-traders.in" }]);
  });

  it("an owner whose setup is already done goes to the dashboard, signed in", async () => {
    st.tenantRow = { id: TENANT, setup_completed_at: "2026-10-20T10:00:00Z" };
    const j = await (await post()).json();
    expect(j).toMatchObject({ ok: true, signedIn: true, next: "/dashboard" });
  });

  it("a team member (not owner) goes to the dashboard, never the owner-only wizard", async () => {
    st.userRow = { id: UID, tenant_id: TENANT, role: "sales" };
    const j = await (await post()).json();
    expect(j).toMatchObject({ ok: true, signedIn: true, next: "/dashboard" });
  });

  it("a person parked on a join request gets NO session (no workspace of their own)", async () => {
    st.routed = { tenantName: "Rao Traders" };
    st.userRow = null;
    const j = await (await post()).json();
    expect(j).toMatchObject({ ok: true, joinRequestedTo: "Rao Traders", signedIn: false });
    expect(j.next).toBeUndefined();
    expect(st.sessionCalls).toEqual([]);
  });

  it("an address with no profile row gets NO session", async () => {
    st.userRow = null;
    const j = await (await post()).json();
    expect(j).toMatchObject({ ok: true, signedIn: false });
    expect(st.sessionCalls).toEqual([]);
  });

  it("a used / expired / bad token never signs anyone in", async () => {
    for (const reason of ["used", "expired", "invalid"]) {
      st.confirm = { ok: false, reason };
      const res = await post();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, reason });
    }
    expect(st.sessionCalls).toEqual([]);
  });

  it("if the session cannot be made, the email is still confirmed and the page offers Sign in", async () => {
    st.sessionOk = false;
    const j = await (await post()).json();
    expect(j).toMatchObject({ ok: true, signedIn: false });
    expect(j.next).toBeUndefined();
  });
});
