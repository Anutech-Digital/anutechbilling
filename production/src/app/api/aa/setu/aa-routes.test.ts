/**
 * R-879 — Bank (Setu AA) routes.
 *
 * Before (manager-pardeep 514efbdb):
 *   - src/app/api/aa/setu/callback/route.ts:15-58 — an unauthenticated GET: anyone holding a
 *     consent handle flipped that connection to `active` / `rejected`. No signed state.
 *   - src/app/api/aa/setu/fetch/[connectionId]/route.ts:18-22 — R-732 role gate, but no second
 *     sign-in step: a stolen password alone pulled a company's bank statements.
 * Now: money roles only (shared withRoute guard), aal2 session, and a callback that changes
 * nothing unless `state` was signed by consent/init for this tenant + connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const CONN = "22222222-2222-4222-8222-222222222222";

const st = vi.hoisted(() => ({
  role: "owner" as string,
  aal: "aal2" as string,
  conn: null as Record<string, unknown> | null,
  writes: [] as string[],
  setuStatus: "ACTIVE" as string,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string): unknown => {
    const result = () => {
      if (table === "users") return { data: { tenant_id: TENANT, role: st.role }, error: null };
      if (table === "bank_aa_connections") return { data: st.conn, error: null };
      return { data: null, error: null };
    };
    const self: unknown = new Proxy({}, {
      get(_t, prop: string | symbol) {
        if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
        if (prop === "single" || prop === "maybeSingle") return async () => result();
        return () => {
          if (prop === "insert" || prop === "update" || prop === "delete") st.writes.push(`${table}.${String(prop)}`);
          return self;
        };
      },
    });
    return self;
  };
  const client = () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, email: "t@example.test" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: st.aal, nextLevel: "aal2" }, error: null }) },
    },
    from: (t: string) => chain(t),
  });
  return { createClient: client, createAdminClient: client };
});

vi.mock("@/lib/aa/setu", async (orig) => ({
  ...(await orig<typeof import("@/lib/aa/setu")>()),
  getConsentStatus: async () => ({ id: "h1", status: st.setuStatus, consent_id: "cid", linked_accounts: [{ accountRef: "ref" }] }),
  requestFiData: async () => ({ session_id: "s" }),
  fetchFiData: async () => ({ status: "READY", transactions: [] }),
}));

import { GET as callback } from "./callback/route";
import { POST as fetchRoute } from "./fetch/[connectionId]/route";
import { signConsentState, verifyConsentState } from "@/lib/aa/consent-state";
import { AA_MFA_REFUSAL } from "@/lib/aa/require-mfa";

const pending = () => ({ id: CONN, bank_account_id: "b1", tenant_id: TENANT, consent_handle_id: "h1", status: "pending_approval" });
const cb = (qs: string) => callback(new NextRequest(`http://localhost:3001/api/aa/setu/callback?${qs}`));
const fetchIt = () =>
  fetchRoute(new NextRequest(`http://localhost:3001/api/aa/setu/fetch/${CONN}`, { method: "POST" }), {
    params: Promise.resolve({ connectionId: CONN }),
  });

beforeEach(() => {
  vi.stubEnv("PDF_SIGNING_SECRET", "test-signing-secret-r879");
  st.role = "owner"; st.aal = "aal2"; st.conn = pending(); st.writes = []; st.setuStatus = "ACTIVE";
});
afterEach(() => vi.unstubAllEnvs());

describe("consent state (lib/aa/consent-state.ts)", () => {
  it("verifies only for the tenant + connection it was signed for, and only until it expires", () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const s = signConsentState(TENANT, CONN, now);
    expect(verifyConsentState(s, TENANT, CONN, now)).toEqual({ ok: true });
    expect(verifyConsentState(s, OTHER_TENANT, CONN, now).ok).toBe(false);
    expect(verifyConsentState(s, TENANT, "33333333-3333-4333-8333-333333333333", now).ok).toBe(false);
    expect(verifyConsentState(s, TENANT, CONN, new Date(now.getTime() + 61 * 60_000))).toEqual({ ok: false, reason: "expired" });
    expect(verifyConsentState(s.replace(/.$/, (c) => (c === "0" ? "1" : "0")), TENANT, CONN, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyConsentState("", TENANT, CONN, now).ok).toBe(false);
  });
});

describe("R-879 callback (callback/route.ts) — changes state only with a valid signed state", () => {
  it("no state (the old URL shape) → 403, connection untouched", async () => {
    const res = await cb("handle=h1&approved=true");
    expect(res.status).toBe(403);
    expect(st.writes).toEqual([]);
    expect((await res.json()).error).toMatch(/Connect bank/);
  });

  it("forged state → 403, untouched; approved=false with forged state cannot reject it either", async () => {
    const forged = `${Math.floor(Date.now() / 1000) + 600}.${CONN}.${"a".repeat(64)}`;
    expect((await cb(`handle=h1&approved=true&state=${forged}`)).status).toBe(403);
    expect((await cb(`handle=h1&approved=false&state=${forged}`)).status).toBe(403);
    expect(st.writes).toEqual([]);
  });

  it("state signed for another tenant → 403", async () => {
    const s = signConsentState(OTHER_TENANT, CONN);
    expect((await cb(`handle=h1&state=${encodeURIComponent(s)}`)).status).toBe(403);
    expect(st.writes).toEqual([]);
  });

  it("valid state but a different handle → 403", async () => {
    const s = signConsentState(TENANT, CONN);
    expect((await cb(`handle=other&state=${encodeURIComponent(s)}`)).status).toBe(403);
    expect(st.writes).toEqual([]);
  });

  it("valid state, already active → 409, not flipped again", async () => {
    st.conn = { ...pending(), status: "active" };
    const s = signConsentState(TENANT, CONN);
    expect((await cb(`handle=h1&state=${encodeURIComponent(s)}`)).status).toBe(409);
    expect(st.writes).toEqual([]);
  });

  it("provider does not say ACTIVE → 409, untouched", async () => {
    st.setuStatus = "PENDING";
    const s = signConsentState(TENANT, CONN);
    expect((await cb(`handle=h1&state=${encodeURIComponent(s)}`)).status).toBe(409);
    expect(st.writes).toEqual([]);
  });

  it("sales role → 403 before any change", async () => {
    st.role = "sales";
    const s = signConsentState(TENANT, CONN);
    expect((await cb(`handle=h1&state=${encodeURIComponent(s)}`)).status).toBe(403);
    expect(st.writes).toEqual([]);
  });

  it("valid state + owner + aal2 → connection activated, redirect to the bank page", async () => {
    const s = signConsentState(TENANT, CONN);
    const res = await cb(`handle=h1&approved=true&state=${encodeURIComponent(s)}`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/accounting/banking/b1?aa=connected");
    expect(st.writes).toEqual(["bank_aa_connections.update"]);
  });
});

describe("R-879 fetch (fetch/[connectionId]/route.ts) — money roles + second sign-in step", () => {
  beforeEach(() => { st.conn = { ...pending(), status: "active", last_fetch_at: null, fetch_window_from: "2026-10-01" }; });

  it.each(["sales", "support", "viewer"])("%s → 403, nothing written", async (role) => {
    st.role = role;
    expect((await fetchIt()).status).toBe(403);
    expect(st.writes).toEqual([]);
  });

  it("owner on an aal1 session (no authenticator code) → 403 with the MFA how-to", async () => {
    st.aal = "aal1";
    const res = await fetchIt();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe(AA_MFA_REFUSAL);
    expect(body.mfaRequired).toBe(true);
    expect(st.writes).toEqual([]);
  });

  it.each(["owner", "accountant"])("%s on aal2 → allowed", async (role) => {
    st.role = role;
    expect((await fetchIt()).status).toBe(200);
  });
});
