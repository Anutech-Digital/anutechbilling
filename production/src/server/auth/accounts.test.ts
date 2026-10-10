import { describe, expect, it } from "vitest";
import { linkOAuthUser, type AuthUser, type OAuthStore } from "./accounts";

/* R-529: a Google sign-in must land on the EXISTING account (same id → same tenant + role),
   never a second one. The store is faked: auth.users rows, auth.identities, and the
   public.users profiles (id → tenant/role) the app's data hangs off. */

const OWNER = "c21b44a9-d508-4769-beb4-1447e12b9077";
const TENANT = "fbb976f1-9090-4f10-9726-0901bd144e42";
const STRAY = "6172ee49-0000-4000-8000-000000000000";

function user(id: string, email: string, extra: Partial<AuthUser> = {}): AuthUser {
  return {
    id, aud: "authenticated", role: "authenticated", email, email_confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_at: "2026-01-01T00:00:00.000Z", phone: "", last_sign_in_at: null, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", app_metadata: {}, user_metadata: {}, identities: [], is_anonymous: false,
    banned_until: null, ...extra,
  };
}

interface Profile { id: string; email: string; tenant_id: string; role: string }

function fakeStore(init: {
  users?: AuthUser[];
  identities?: { provider: string; subject: string; userId: string }[];
  profiles?: Profile[];
}) {
  const users = new Map((init.users ?? []).map((u) => [u.id, u]));
  const profiles = init.profiles ?? [];
  const created: AuthUser[] = [];
  let n = 0;
  const store: OAuthStore = {
    async userIdForIdentity(provider, subject) {
      return init.identities?.find((i) => i.provider === provider && i.subject === subject)?.userId ?? null;
    },
    async profileIdForEmail(email) {
      return profiles.find((p) => p.email.toLowerCase() === email.toLowerCase())?.id ?? null;
    },
    async byEmail(email) {
      return [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
    },
    async byId(id) { return users.get(id) ?? null; },
    async create(input, id) {
      if ([...users.values()].some((u) => u.email === input.email)) throw new Error("email_exists");
      const u = user(id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, input.email);
      users.set(u.id, u);
      created.push(u);
      return u;
    },
    async confirm(id) {
      const u = { ...users.get(id)!, email_confirmed_at: "2026-10-09T00:00:00.000Z" };
      users.set(id, u);
      return u;
    },
  };
  const tenantOf = (id: string) => profiles.find((p) => p.id === id) ?? null;
  return { store, created, tenantOf };
}

const ownerProfile: Profile = { id: OWNER, email: "pardeep@anutech.in", tenant_id: TENANT, role: "owner" };
const google = (email: string, extra: { emailVerified?: boolean; subject?: string } = {}) =>
  ({ email, emailVerified: true, name: "Pardeep", provider: "google", subject: "g-sub-1", ...extra });

describe("R-529: Google sign-in links to the existing account", () => {
  it("existing email (auth.users + profile) → SAME id, so the same tenant and role", async () => {
    const f = fakeStore({ users: [user(OWNER, "pardeep@anutech.in")], profiles: [ownerProfile] });
    const r = await linkOAuthUser(google("Pardeep@Anutech.in "), f.store);
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(f.tenantOf(OWNER)).toMatchObject({ tenant_id: TENANT, role: "owner" });
    expect(f.created).toEqual([]);
  });

  it("the Google identity GoTrue linked wins, even when the login's email differs", async () => {
    const f = fakeStore({
      users: [user(OWNER, "sales@anutech.in")],
      identities: [{ provider: "google", subject: "g-sub-1", userId: OWNER }],
      profiles: [{ ...ownerProfile, email: "sales@anutech.in" }],
    });
    const r = await linkOAuthUser(google("pardeep@anutech.in"), f.store);
    expect(r).toMatchObject({ ok: true, how: "identity" });
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(f.created).toEqual([]);
  });

  it("the profile owns the address but its login has another email → still the profile's id", async () => {
    const f = fakeStore({ users: [user(OWNER, "old-login@anutech.in")], profiles: [ownerProfile] });
    const r = await linkOAuthUser(google("pardeep@anutech.in", { subject: "other-sub" }), f.store);
    expect(r).toMatchObject({ ok: true, how: "profile" });
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(f.created).toEqual([]);
  });

  it("a stray duplicate login (the staging 6172ee49 case) is bypassed: the profile's id wins", async () => {
    const f = fakeStore({
      users: [user(STRAY, "pardeep@anutech.in"), user(OWNER, "pardeep.old@anutech.in")],
      profiles: [ownerProfile],
    });
    const r = await linkOAuthUser(google("pardeep@anutech.in"), f.store);
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(f.created).toEqual([]);
  });

  it("profile exists but has NO login row → login created WITH the profile's id (not a new one)", async () => {
    const f = fakeStore({ profiles: [ownerProfile] });
    const r = await linkOAuthUser(google("pardeep@anutech.in"), f.store);
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(f.created.map((u) => u.id)).toEqual([OWNER]);
  });

  it("profile without a login, while another login holds the address → refused, never forked", async () => {
    const f = fakeStore({ users: [user(STRAY, "pardeep@anutech.in")], profiles: [ownerProfile] });
    expect(await linkOAuthUser(google("pardeep@anutech.in"), f.store)).toEqual({ ok: false, reason: "conflict" });
    expect(f.created).toEqual([]);
  });

  it("new email → a new user with no tenant", async () => {
    const f = fakeStore({ users: [user(OWNER, "pardeep@anutech.in")], profiles: [ownerProfile] });
    const r = await linkOAuthUser(google("someone.new@example.test", { subject: "g-sub-2" }), f.store);
    expect(r).toMatchObject({ ok: true, how: "created" });
    expect(r.ok && r.user.id).not.toBe(OWNER);
    expect(r.ok && f.tenantOf(r.user.id)).toBeNull();
    expect(f.created).toHaveLength(1);
  });

  it("unverified Google email → refused before any lookup, nothing created", async () => {
    const f = fakeStore({ users: [user(OWNER, "pardeep@anutech.in")], profiles: [ownerProfile] });
    let looked = false;
    const spy: OAuthStore = {
      ...f.store,
      async userIdForIdentity(p, s) { looked = true; return f.store.userIdForIdentity(p, s); },
      async profileIdForEmail(e) { looked = true; return f.store.profileIdForEmail(e); },
    };
    expect(await linkOAuthUser(google("pardeep@anutech.in", { emailVerified: false }), spy)).toEqual({ ok: false, reason: "unverified" });
    expect(looked).toBe(false);
    expect(f.created).toEqual([]);
  });

  it("banned existing account → refused", async () => {
    const f = fakeStore({ users: [user(OWNER, "pardeep@anutech.in", { banned_until: "2999-01-01T00:00:00.000Z" })] });
    expect(await linkOAuthUser(google("pardeep@anutech.in"), f.store)).toEqual({ ok: false, reason: "banned" });
  });

  it("an unconfirmed existing login is confirmed (Google proved the address) — same id", async () => {
    const f = fakeStore({ users: [user(OWNER, "pardeep@anutech.in", { email_confirmed_at: null, confirmed_at: null })] });
    const r = await linkOAuthUser(google("pardeep@anutech.in"), f.store);
    expect(r.ok && r.user.id).toBe(OWNER);
    expect(r.ok && r.user.email_confirmed_at).toBeTruthy();
  });
});
