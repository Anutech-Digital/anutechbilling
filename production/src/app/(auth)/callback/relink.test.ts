/**
 * R-1301: a first Google sign-in never rewrites users.id.
 *   · an existing profile (matched by email) keeps its id — in both login layers;
 *   · the refusal is written to activity_log (old id, new id, provider) and the fresh session closed;
 *   · an unverified address never reaches any email-based lookup;
 *   · under AUTH_PROVIDER=authjs the legacy code exchange is never used.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as { table: string; patch: Row }[],
  inserts: [] as { table: string; row: Row }[],
  emailReads: [] as string[],
}));

/** A tiny PostgREST-shaped fake: select/eq/is/maybeSingle, insert, update. */
function fakeAdmin() {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          if (k === "email") db.emailReads.push(table);
          filters.push([k, v]);
          if (mode === "update") {
            db.updates.push({ table, patch });
            return Promise.resolve({ error: null });
          }
          return q;
        },
        ilike: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        is: (k: string, v: unknown) => { filters.push([k, v ?? undefined]); return q; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        update: (p: Row) => { mode = "update"; patch = p; return q; },
        insert: async (row: Row) => { db.inserts.push({ table, row }); return { error: null }; },
      };
      return q;
    },
  };
}

const exchangeCodeForSession = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const provider = vi.hoisted(() => ({ value: "gotrue" as "gotrue" | "authjs" }));
const authjsUser = vi.hoisted(() => ({ value: null as null | { user: Row } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { exchangeCodeForSession, signOut, verifyOtp: vi.fn() } }),
  createAdminClient: () => fakeAdmin(),
}));
vi.mock("@/server/auth/authjs", () => ({ authProvider: () => provider.value }));
vi.mock("@/server/auth/compat", () => ({ currentAuthUser: async () => authjsUser.value }));
vi.mock("@/lib/auth/tenant-match", () => ({
  findVerifiedDomainTenant: vi.fn(async () => { db.emailReads.push("domain"); return null; }),
  openJoinRequest: vi.fn(async () => ({ ok: true })),
  notifyOwnerOfJoinRequest: vi.fn(async () => undefined),
}));

import { GET } from "./route";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_UID    = "22222222-2222-4222-8222-222222222222";
const TENANT     = "33333333-3333-4333-8333-333333333333";
const EMAIL      = "pardeep@anutech.in";

const req = (qs: string) =>
  new NextRequest(`https://app.example/callback?${qs}`, { headers: { host: "app.example", "x-forwarded-proto": "https" } });
const googleUser = (over: Row = {}) => ({
  id: NEW_UID, email: EMAIL, email_confirmed_at: "2026-10-12T00:00:00Z",
  user_metadata: { full_name: "Pardeep Sharma" }, ...over,
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example");
  db.tables = { users: [{ id: PROFILE_ID, tenant_id: TENANT, role: "owner", email: EMAIL }] };
  db.updates = []; db.inserts = []; db.emailReads = [];
  exchangeCodeForSession.mockReset(); signOut.mockClear();
  provider.value = "gotrue"; authjsUser.value = null;
});

describe("GoTrue path: existing profile matched by email", () => {
  it("keeps users.id — never updates the users row", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser() }, error: null });
    const res = await GET(req("code=abc"));
    expect(db.updates.filter((u) => u.table === "users")).toEqual([]);
    expect(db.tables.users[0].id).toBe(PROFILE_ID);
    expect(res.headers.get("location")).toBe("https://app.example/login?error=account_link_conflict");
  });

  it("writes one activity_log row with old id, new id and provider — no email, no token", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser() }, error: null });
    await GET(req("code=abc"));
    const logs = db.inserts.filter((i) => i.table === "activity_log");
    expect(logs).toHaveLength(1);
    const row = logs[0].row as { tenant_id: string; user_id: string; action: string; changes: Row };
    expect(row.tenant_id).toBe(TENANT);
    expect(row.user_id).toBe(PROFILE_ID);
    expect(row.action).toBe("auth.oauth_link_refused");
    expect(row.changes).toMatchObject({ old_id: PROFILE_ID, new_id: NEW_UID, provider: "google", layer: "gotrue" });
    expect(JSON.stringify(row)).not.toContain(EMAIL);
  });

  it("closes the fresh session so nobody is left signed in without a profile", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser() }, error: null });
    await GET(req("code=abc"));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("a returning user (row under the login's own id) goes straight in, untouched", async () => {
    db.tables.users[0].id = NEW_UID;
    exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser() }, error: null });
    const res = await GET(req("code=abc&next=/leads"));
    expect(res.headers.get("location")).toBe("https://app.example/leads");
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("unverified email never links", () => {
  it("refuses before any email-based lookup (profile, invite, domain)", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: googleUser({ email_confirmed_at: null }) }, error: null });
    const res = await GET(req("code=abc"));
    expect(res.headers.get("location")).toBe("https://app.example/login?error=email_unverified");
    expect(db.emailReads).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
    expect(db.tables.users[0].id).toBe(PROFILE_ID);
  });

  it("user_metadata.email_verified (user-writable) does not count", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { user: googleUser({ email_confirmed_at: null, user_metadata: { email_verified: true } }) }, error: null,
    });
    const res = await GET(req("code=abc"));
    expect(res.headers.get("location")).toBe("https://app.example/login?error=email_unverified");
    expect(db.emailReads).toEqual([]);
  });
});

describe("AUTH_PROVIDER=authjs: the legacy callback never re-links", () => {
  beforeEach(() => { provider.value = "authjs"; });

  it("never exchanges a GoTrue code, even when one is passed", async () => {
    authjsUser.value = { user: googleUser({ id: PROFILE_ID }) };
    db.tables.users[0].id = PROFILE_ID;
    await GET(req("code=abc"));
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("a profile under a different id is NOT moved to the Auth.js login", async () => {
    authjsUser.value = { user: googleUser() };
    const res = await GET(req("code=abc"));
    expect(db.updates.filter((u) => u.table === "users")).toEqual([]);
    expect(db.tables.users[0].id).toBe(PROFILE_ID);
    expect(res.headers.get("location")).toBe("https://app.example/login?error=account_link_conflict");
    const log = db.inserts.find((i) => i.table === "activity_log")?.row as { changes: Row } | undefined;
    expect(log?.changes).toMatchObject({ layer: "authjs", old_id: PROFILE_ID, new_id: NEW_UID });
  });

  it("no Auth.js session → back to login, nothing read or written", async () => {
    const res = await GET(req("code=abc"));
    expect(res.headers.get("location")).toBe("https://app.example/login?error=auth_failed");
    expect(db.emailReads).toEqual([]);
    expect(db.inserts).toEqual([]);
  });
});
