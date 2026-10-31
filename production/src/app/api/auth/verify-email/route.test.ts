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
  /* R-2119: the personal door */
  appMeta: {} as Record<string, unknown>,
  routeCalls: 0,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; row: Record<string, unknown>; where: Record<string, unknown> }>,
  linkCalls: [] as Array<[string, string]>,
}));

vi.mock("@/lib/app-url", () => ({ trustedOrigin: () => "http://localhost:3001" }));
vi.mock("@/lib/auth/email-verification", () => ({ confirmEmailToken: async () => st.confirm }));
vi.mock("@/lib/auth/tenant-match", () => ({ routeVerifiedSignupToCompany: async () => { st.routeCalls++; return st.routed; } }));
vi.mock("@/server/auth/email-link", () => ({
  startSessionAfterVerify: async (a: { userId: string; email: string }) => { st.sessionCalls.push(a); return st.sessionOk; },
}));
vi.mock("@/lib/personal/identity-link.server", () => ({
  linkPersonalIdentity: async (u: string, t: string) => {
    st.linkCalls.push([u, t]);
    return { ok: true, status: "linked", customerId: "c1", customerCreated: true, panelQueued: true, supportQueued: true };
  },
}));
vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    const where: Record<string, unknown> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    self.select = () => self;
    self.eq = (c: string, v: unknown) => { where[c] = v; return self; };
    self.is = (c: string, v: unknown) => { where[c] = v; return self; };
    self.maybeSingle = async () => ({ data: table === "users" ? st.userRow : table === "tenants" ? st.tenantRow : null, error: null });
    self.insert = (row: Record<string, unknown>) => {
      st.inserts.push({ table, row });
      if (table === "users") st.userRow = { id: row.id, tenant_id: row.tenant_id, role: row.role };
      if (table === "tenants") st.tenantRow = { id: row.id, setup_completed_at: null };
      return Promise.resolve({ error: null });
    };
    self.update = (row: Record<string, unknown>) => { pendingUpdate = row; return self; };
    self.delete = () => self;
    self.then = (res: (v: unknown) => unknown) => {
      if (pendingUpdate) st.updates.push({ table, row: pendingUpdate, where: { ...where } });
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    return self;
  };
  return {
    createAdminClient: () => ({
      from: (t: string) => chain(t),
      auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: { full_name: "Asha Rao" }, app_metadata: st.appMeta } } }) } },
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
  st.appMeta = {};
  st.routeCalls = 0;
  st.inserts = [];
  st.updates = [];
  st.linkCalls = [];
  vi.unstubAllEnvs();
});

/* R-2119 (GP-05, G-PERSONAL): the confirm link is where a password personal signup gets its
   workspace — never before (signup made only the login + consent). Before this card verify-email
   only routed by domain and signed in someone who ALREADY had a users row, so a personal signup
   would have stayed with no workspace (or been parked on a company's join request). */
describe("R-2119: verify creates the personal workspace", () => {
  const personalSignup = () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    st.appMeta = { signup_kind: "personal" };
    st.userRow = null;
    st.tenantRow = null;
    st.confirm = { ok: true, email: "meera@gmail.com", userId: UID };
  };

  it("1 personal tenant (name = full name, no GSTIN/state/business type), role personal, consent attached, link made, lands on /money", async () => {
    personalSignup();
    const j = await (await post()).json();
    const tenants = st.inserts.filter((i) => i.table === "tenants").map((i) => i.row);
    const users = st.inserts.filter((i) => i.table === "users").map((i) => i.row);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ name: "Asha Rao", workspace_kind: "personal", gstin: null, business_type: null, email: "meera@gmail.com" });
    expect(tenants[0]).not.toHaveProperty("state");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: UID, tenant_id: tenants[0].id, role: "personal" });
    expect(st.inserts.some((i) => i.table === "tenant_domains")).toBe(false);
    const consent = st.updates.find((u) => u.table === "consent_events");
    expect(consent).toMatchObject({ row: { tenant_id: tenants[0].id }, where: { user_id: UID, tenant_id: null } });
    expect(st.linkCalls).toEqual([[UID, tenants[0].id]]);
    expect(j).toMatchObject({ ok: true, signedIn: true, next: "/money", joinRequestedTo: null });
  });

  it("a work-email personal signup is NEVER routed to that company's join request", async () => {
    personalSignup();
    st.routed = { tenantName: "Rao Traders" };
    const j = await (await post()).json();
    expect(st.routeCalls).toBe(0);
    expect(j.joinRequestedTo).toBeNull();
    expect(j.next).toBe("/money");
  });

  it("a person who already has a users row gets no second workspace", async () => {
    personalSignup();
    st.userRow = { id: UID, tenant_id: TENANT, role: "personal" };
    st.tenantRow = { id: TENANT, setup_completed_at: null };
    const j = await (await post()).json();
    expect(st.inserts).toEqual([]);
    expect(j.next).toBe("/money");
  });

  it("with the flag off, nothing is created for a personal signup", async () => {
    personalSignup();
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "");
    const j = await (await post()).json();
    expect(st.inserts).toEqual([]);
    expect(st.linkCalls).toEqual([]);
    expect(j.signedIn).toBe(false);
  });

  it("a business signup is untouched: routed by domain as before, no personal workspace", async () => {
    vi.stubEnv("PERSONAL_SIGNUP_ENABLED", "1");
    await post();
    expect(st.routeCalls).toBe(1);
    expect(st.inserts).toEqual([]);
    expect(st.linkCalls).toEqual([]);
  });
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
