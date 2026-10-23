/**
 * R-1771 — the DMS SSO token also names the ResellerOS customer (`billing_customer_id`), so DMS
 * can link its user to the customer by ID instead of only by matching emails.
 *
 * Pinned (the route's security model stays true):
 *   - the customer comes ONLY from the caller's own session: `portal_my_customer()` on the
 *     session client (it resolves auth.uid() in the database) — no service role, and nothing in
 *     the request can choose or change it;
 *   - the email is still the session's email;
 *   - a staff user (no customer login) or an ambiguous login (the RPC returns nothing) → no claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = { id: string; customer_number: string | null };
const s = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  /** What portal_my_customer() answers for each auth user id (the database's auth.uid()). */
  portal: {} as Record<string, Row[]>,
  rpcCalls: [] as unknown[][],
  adminUsed: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: s.user } }) },
    rpc: async (...args: unknown[]) => {
      s.rpcCalls.push(args);
      return { data: s.user ? (s.portal[s.user.id] ?? []) : [], error: null };
    },
  }),
  createAdminClient: () => { s.adminUsed = true; throw new Error("the SSO route must not use the service role"); },
}));

function claims(location: string | null): Record<string, unknown> {
  const token = new URL(String(location)).searchParams.get("token") ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

async function call(query = "next=dashboard") {
  const { GET } = await import("./route");
  return GET(new NextRequest(`https://ros.invalid/api/dms/sso?${query}`));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DMS_SSO_SECRET", "test-sso-secret");
  vi.stubEnv("DMS_ENGINE_URL", "https://dms.invalid");
  s.user = { id: "auth-asha", email: "Asha@Acme.in" };
  s.portal = {
    "auth-asha": [{ id: "cust-1", customer_number: "C-00007" }],
    "auth-ravi": [{ id: "cust-2", customer_number: "C-00008" }],
  };
  s.rpcCalls = [];
  s.adminUsed = false;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("R-1771: the SSO token names the ResellerOS customer", () => {
  it("a customer's own login → billing_customer_id = their customer number, email from the session", async () => {
    const res = await call();
    expect(res.status).toBe(307);
    const c = claims(res.headers.get("location"));
    expect(c.billing_customer_id).toBe("C-00007");
    expect(c.email).toBe("asha@acme.in");
  });

  it("no customer number yet → the customer's uuid (same id /api/v1 answers to)", async () => {
    s.portal["auth-asha"] = [{ id: "cust-1", customer_number: null }];
    const c = claims((await call()).headers.get("location"));
    expect(c.billing_customer_id).toBe("cust-1");
  });

  it("the request cannot pick another customer — read via the session, no arguments, no service role", async () => {
    const res = await call("next=dashboard&customer=C-00008&billing_customer_id=C-00008&email=ravi@acme.in&user=auth-ravi");
    const c = claims(res.headers.get("location"));
    expect(c.billing_customer_id).toBe("C-00007");
    expect(c.email).toBe("asha@acme.in");
    expect(s.rpcCalls).toEqual([["portal_my_customer"]]);
    expect(s.adminUsed).toBe(false);
  });

  it("a staff user (no customer login) → no customer claim", async () => {
    s.user = { id: "auth-owner", email: "owner@reseller.in" };
    const c = claims((await call("next=admin")).headers.get("location"));
    expect(c).not.toHaveProperty("billing_customer_id");
    expect(c.email).toBe("owner@reseller.in");
  });

  it("an ambiguous login (the database names no single customer) → no claim, never a guess", async () => {
    s.portal["auth-asha"] = [];
    const c = claims((await call()).headers.get("location"));
    expect(c).not.toHaveProperty("billing_customer_id");
  });

  it("not signed in → 401, no token", async () => {
    s.user = null;
    expect((await call()).status).toBe(401);
  });
});
