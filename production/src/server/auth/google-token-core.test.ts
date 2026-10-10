import { describe, expect, it, vi } from "vitest";
import {
  classifyGoogleApiError, googleReasonMessage, resolveGoogleToken,
  type GoogleTokenDeps, type SessionGoogle, type StoredConnection,
} from "./google-token-core";

const NOW = 1_800_000_000_000;
const RESELLER = "openid email https://www.googleapis.com/auth/apps.order";

function deps(over: Partial<GoogleTokenDeps> = {}): GoogleTokenDeps {
  return {
    now: () => NOW,
    readConnection: async () => null,
    refreshConnection: vi.fn(async () => ({ accessToken: "conn-new", expiresAt: NOW + 3_600_000 })),
    saveConnection: vi.fn(async () => undefined),
    readSession: async () => null,
    refreshSession: vi.fn(async () => ({ accessToken: "sess-new", expiresAt: NOW + 3_600_000 })),
    saveSession: vi.fn(async () => undefined),
    hasScope: (_need, scopes) => (scopes ?? "").includes("apps.order"),
    canRefresh: () => true,
    ...over,
  };
}
const conn = (c: Partial<StoredConnection>): StoredConnection => ({ accessToken: "conn-old", refreshToken: "sealed-rt", expiresAt: NOW + 3_600_000, scopes: RESELLER, ...c });
const authjs = (s: Partial<SessionGoogle>): SessionGoogle => ({ accessToken: "gat", refreshToken: "grt", expiresAt: NOW + 3_600_000, scopes: RESELLER, scopesKnown: true, ...s });

describe("R-824 getGoogleAccessToken — saved connection", () => {
  it("fresh token → used as is, no refresh", async () => {
    const d = deps({ readConnection: async () => conn({}) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "conn-old", source: "connection" });
    expect(d.refreshConnection).not.toHaveBeenCalled();
  });

  it("expired (or within a minute of it) → refreshed and saved", async () => {
    const d = deps({ readConnection: async () => conn({ expiresAt: NOW + 30_000 }) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "conn-new", source: "connection" });
    expect(d.refreshConnection).toHaveBeenCalledWith("sealed-rt");
    expect(d.saveConnection).toHaveBeenCalledWith({ accessToken: "conn-new", expiresAt: NOW + 3_600_000 });
  });

  it("refresh refused by Google → needs_reauth", async () => {
    const d = deps({
      readConnection: async () => conn({ expiresAt: NOW - 1 }),
      refreshConnection: vi.fn(async () => { throw new Error("invalid_grant"); }),
    });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("connected without the Reseller permission → missing_scope (no refresh attempted)", async () => {
    const d = deps({ readConnection: async () => conn({ scopes: "openid email https://www.googleapis.com/auth/gmail.send" }) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "missing_scope" });
    expect(d.refreshConnection).not.toHaveBeenCalled();
  });

  it("expired and the server has no OAuth client → not_configured", async () => {
    const d = deps({ readConnection: async () => conn({ expiresAt: 0 }), canRefresh: () => false });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "not_configured" });
  });

  it("a DB error reading the connection falls through to the session", async () => {
    const d = deps({ readConnection: async () => { throw new Error("db down"); }, readSession: async () => authjs({}) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "gat", source: "session" });
  });
});

describe("R-824 getGoogleAccessToken — AUTH_PROVIDER=authjs (cookie gat/grt/gexp/gscope)", () => {
  it("fresh cookie token with the scope → used", async () => {
    const d = deps({ readSession: async () => authjs({}) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "gat", source: "session" });
  });

  it("expired → refreshed with grt and written back to the cookie", async () => {
    const d = deps({ readSession: async () => authjs({ expiresAt: NOW - 1000 }) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "sess-new", source: "session" });
    expect(d.refreshSession).toHaveBeenCalledWith("grt");
    expect(d.saveSession).toHaveBeenCalledOnce();
  });

  it("expired, refresh refused → needs_reauth", async () => {
    const d = deps({
      readSession: async () => authjs({ expiresAt: NOW - 1000 }),
      refreshSession: vi.fn(async () => { throw new Error("invalid_grant"); }),
    });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("expired and no refresh token → needs_reauth", async () => {
    const d = deps({ readSession: async () => authjs({ expiresAt: NOW - 1000, refreshToken: null }) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("plain Google sign-in (openid email profile) → missing_scope, token not used", async () => {
    const d = deps({ readSession: async () => authjs({ scopes: "openid email profile" }) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "missing_scope" });
    expect(d.refreshSession).not.toHaveBeenCalled();
  });

  it("a failed cookie write still returns the refreshed token", async () => {
    const d = deps({ readSession: async () => authjs({ expiresAt: 0 }), saveSession: vi.fn(async () => { throw new Error("headers sent"); }) });
    expect(await resolveGoogleToken("reseller", d)).toMatchObject({ ok: true, token: "sess-new" });
  });
});

describe("R-824 getGoogleAccessToken — AUTH_PROVIDER=gotrue (Supabase provider_token)", () => {
  const gotrue = (t: string | null): SessionGoogle => ({ accessToken: t, refreshToken: null, expiresAt: 0, scopes: null, scopesKnown: false });

  it("provider_token present → handed over (Google decides on the scope)", async () => {
    const d = deps({ readSession: async () => gotrue("ya29.supabase") });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: true, token: "ya29.supabase", source: "session" });
  });

  it("no provider_token (password login) → not_connected", async () => {
    const d = deps({ readSession: async () => gotrue(null) });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("the saved connection still wins over the session", async () => {
    const d = deps({ readConnection: async () => conn({}), readSession: async () => gotrue("ya29.supabase") });
    expect(await resolveGoogleToken("reseller", d)).toMatchObject({ token: "conn-old" });
  });
});

describe("R-824 reasons", () => {
  it("nothing anywhere → not_connected", async () => {
    expect(await resolveGoogleToken("reseller", deps())).toEqual({ ok: false, reason: "not_connected" });
  });

  it("needs_reauth outranks missing_scope (the most useful thing to tell the person)", async () => {
    const d = deps({
      readConnection: async () => conn({ expiresAt: 0 }),
      refreshConnection: vi.fn(async () => { throw new Error("revoked"); }),
      readSession: async () => authjs({ scopes: "openid email profile" }),
    });
    expect(await resolveGoogleToken("reseller", d)).toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("Google API answers → our codes", () => {
    expect(classifyGoogleApiError(403, '{"reason":"SERVICE_DISABLED"}')).toBe("api_disabled");
    expect(classifyGoogleApiError(403, "Reseller API has not been used in project 1")).toBe("api_disabled");
    expect(classifyGoogleApiError(403, '{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}')).toBe("missing_scope");
    expect(classifyGoogleApiError(401, "invalid credentials")).toBe("needs_reauth");
    expect(classifyGoogleApiError(500, "boom")).toBeNull();
  });

  it("plain-English messages the Settings card shows", () => {
    expect(googleReasonMessage("reseller", "not_connected")).toBe("Connect Google Reseller to see subscriptions");
    expect(googleReasonMessage("reseller", "missing_scope")).toBe("Connect Google Reseller to see subscriptions");
    expect(googleReasonMessage("reseller", "needs_reauth")).toBe("Google needs you to sign in again");
    expect(googleReasonMessage("reseller", "api_disabled")).toBe("The Reseller API is turned off in Google Cloud");
  });
});
