/**
 * R-2351 (G-DPDP) — Google ACCESS tokens sealed at rest, like the refresh token (R-051).
 *
 * Until now every connect callback and every refresh wrote `user_google_tokens.access_token`
 * in PLAINTEXT, right next to the sealed refresh token. An access token is a live key to the
 * person's Gmail / Contacts / Business Profile / Ads for up to an hour — a DB dump taken at
 * the wrong moment exposed every connected mailbox.
 *
 * Proves (fake tokens only, nothing calls Google):
 *   1. every connect callback stores the access token as a `rosv1:` envelope, never the raw value;
 *   2. the refresh paths (Contacts / Business Profile / Ads / R-824 resolver) cache the new
 *      access token SEALED, return the real one, and read a sealed cached one back;
 *   3. a legacy plaintext row still works (read + refresh) and is sealed on that write;
 *   4. no master key: nothing is written (no plaintext fallback), the caller still gets the token;
 *   5. wrong master key: a clear error, Google is not called, nothing is written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { isEncrypted, encryptSecret, decryptSecret } from "@/lib/crypto/vault";

const RAW_ACCESS = "ya29.FAKE-access-token-r2351-abcdefgh";
const RAW_REFRESH = "1//0gFAKE-refresh-token-r2351-ijklmnop";
const NEW_ACCESS = "ya29.FAKE-refreshed-access-r2351-qrstuv";

const h = vi.hoisted(() => {
  const state = {
    tokenRow: null as Record<string, unknown> | null,
    upserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    refreshCalls: 0,
  };
  class Q {
    constructor(private table: string) {}
    select() { return this; }
    eq() { return this; }
    ilike() { return this; }
    limit() { return Promise.resolve({ data: state.tokenRow ? [state.tokenRow] : [], error: null }); }
    async maybeSingle() {
      if (this.table === "users") return { data: { tenant_id: "T1", role: "owner" }, error: null };
      if (this.table === "user_google_tokens") return { data: state.tokenRow, error: null };
      return { data: null, error: null };
    }
    async upsert(row: Record<string, unknown>) { state.upserts.push(row); return { error: null }; }
    update(row: Record<string, unknown>) {
      state.updates.push(row);
      return { eq: async () => ({ error: null }) };
    }
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "U1" } } }), getSession: async () => ({ data: { session: null } }) },
    from: (t: string) => new Q(t),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => h.client, createAdminClient: () => h.client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => "", get: () => undefined }) }));
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("./oauth")>();
  return {
    ...real,
    googleOAuthCreds: () => ({ clientId: "cid", clientSecret: "csecret" }),
    fetchGoogleEmail: async () => "owner@example.com",
    exchangeCode: async () => ({
      access_token: RAW_ACCESS, refresh_token: RAW_REFRESH, expires_in: 3600,
      scope: [
        "openid", "email",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/business.manage",
        "https://www.googleapis.com/auth/adwords",
        "https://www.googleapis.com/auth/apps.order",
      ].join(" "),
    }),
    // The real refreshAccessToken opens the stored value first (that is what decides "wrong
    // key → clear error before Google"); only the network call is faked here.
    refreshAccessToken: async (stored: string, creds: { clientId: string; clientSecret: string }) => {
      void creds;
      const opened = decryptSecret(stored);   // same as openRefreshToken: a wrong key throws here
      if (opened !== RAW_REFRESH) throw new Error("refresh sent Google the wrong token");
      h.state.refreshCalls++;
      return { access_token: NEW_ACCESS, expires_in: 3600, scope: "https://www.googleapis.com/auth/contacts" };
    },
  };
});

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER_KEY = crypto.randomBytes(32).toString("base64");
let originalKey: string | undefined;
beforeEach(() => {
  originalKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = KEY;
  h.state.tokenRow = null;
  h.state.upserts = [];
  h.state.updates = [];
  h.state.refreshCalls = 0;
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = originalKey;
  vi.restoreAllMocks();
});

const ALL_SCOPES = "openid email https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/apps.order";
const future = () => new Date(Date.now() + 30 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

// ── 1. connect callbacks ─────────────────────────────────────────────────────
const CALLBACKS = [
  ["google-contacts", "g_contacts_oauth_state"],
  ["google-gmail", "g_gmail_oauth_state"],
  ["google-business", "g_gbp_oauth_state"],
  ["google-ads", "g_ads_oauth_state"],
  ["google-reseller", "g_reseller_oauth_state"],
] as const;

describe("connect callbacks store the access token sealed", () => {
  for (const [name, stateCookie] of CALLBACKS) {
    it(`${name}: the stored access_token is an envelope that opens to the real token`, async () => {
      const mod = await import(`@/app/api/integrations/${name}/callback/route`);
      const req = new NextRequest(`http://localhost:3000/api/integrations/${name}/callback?code=C1&state=S1`, {
        headers: { cookie: `${stateCookie}=S1` },
      });
      await mod.GET(req);
      expect(h.state.upserts.length, `${name} did not store the connection`).toBe(1);
      const row = h.state.upserts[0];
      expect(isEncrypted(String(row.access_token)), `${name} stored a plaintext access token`).toBe(true);
      expect(decryptSecret(String(row.access_token))).toBe(RAW_ACCESS);
      expect(JSON.stringify(h.state.upserts)).not.toContain(RAW_ACCESS);
      expect(JSON.stringify(h.state.upserts)).not.toContain(RAW_REFRESH);
    });
  }
});

// ── 2–5. refresh paths ───────────────────────────────────────────────────────
type Getter = () => Promise<string>;
const REFRESH_PATHS: [string, () => Promise<Getter>][] = [
  ["contacts", async () => { const m = await import("./contacts"); return () => m.getFreshAccessToken(h.client as never, "U1"); }],
  ["business profile", async () => { const m = await import("./gbp-api"); return () => m.getFreshGbpAccessToken(h.client as never, "U1"); }],
  ["google ads", async () => { const m = await import("./google-ads-api"); return () => m.getFreshGoogleAdsAccessToken(h.client as never, "U1"); }],
  ["R-824 resolver", async () => {
    const m = await import("@/server/auth/google-token");
    return async () => {
      const r = await m.getGoogleAccessToken("contacts", "U1");
      if (!r.ok) throw new Error(`resolver said ${r.reason}`);
      return r.token;
    };
  }],
];

describe("refresh paths: sealed cache, legacy rows, missing / wrong key", () => {
  for (const [name, load] of REFRESH_PATHS) {
    it(`${name}: a sealed, still-valid cached access token is opened (no refresh)`, async () => {
      h.state.tokenRow = { user_id: "U1", access_token: encryptSecret(RAW_ACCESS), refresh_token: encryptSecret(RAW_REFRESH), token_expiry: future(), scopes: ALL_SCOPES };
      const get = await load();
      expect(await get()).toBe(RAW_ACCESS);
      expect(h.state.refreshCalls).toBe(0);
    });

    it(`${name}: an expired token is refreshed and the new one is cached SEALED only`, async () => {
      h.state.tokenRow = { user_id: "U1", access_token: encryptSecret(RAW_ACCESS), refresh_token: encryptSecret(RAW_REFRESH), token_expiry: past(), scopes: ALL_SCOPES };
      const get = await load();
      expect(await get()).toBe(NEW_ACCESS);
      expect(h.state.updates).toHaveLength(1);
      const cached = String(h.state.updates[0].access_token);
      expect(isEncrypted(cached)).toBe(true);
      expect(decryptSecret(cached)).toBe(NEW_ACCESS);
      expect(JSON.stringify(h.state.updates)).not.toContain(NEW_ACCESS);
    });

    it(`${name}: a legacy PLAINTEXT row still works and is sealed on that write`, async () => {
      h.state.tokenRow = { user_id: "U1", access_token: RAW_ACCESS, refresh_token: RAW_REFRESH, token_expiry: future(), scopes: ALL_SCOPES };
      const get = await load();
      expect(await get()).toBe(RAW_ACCESS);                       // valid legacy cache is used as is
      h.state.tokenRow = { ...h.state.tokenRow, token_expiry: past() };
      expect(await get()).toBe(NEW_ACCESS);
      const patch = h.state.updates.at(-1)!;
      expect(isEncrypted(String(patch.access_token))).toBe(true);
      expect(isEncrypted(String(patch.refresh_token))).toBe(true);   // R-051 reseal rides along
      expect(JSON.stringify(h.state.updates)).not.toContain(RAW_REFRESH);
    });

    it(`${name}: no master key → nothing written (no plaintext fallback), caller still gets the token`, async () => {
      h.state.tokenRow = { user_id: "U1", access_token: RAW_ACCESS, refresh_token: RAW_REFRESH, token_expiry: past(), scopes: ALL_SCOPES };
      delete process.env.SECRETS_MASTER_KEY;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const get = await load();
      expect(await get()).toBe(NEW_ACCESS);
      expect(h.state.updates).toEqual([]);
      expect(JSON.stringify(err.mock.calls)).toMatch(/SECRETS_MASTER_KEY/);
      expect(JSON.stringify(err.mock.calls)).not.toContain(NEW_ACCESS);
    });

    it(`${name}: WRONG master key → clear error, Google not called, nothing written`, async () => {
      h.state.tokenRow = { user_id: "U1", access_token: encryptSecret(RAW_ACCESS), refresh_token: encryptSecret(RAW_REFRESH), token_expiry: future(), scopes: ALL_SCOPES };
      process.env.SECRETS_MASTER_KEY = OTHER_KEY;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const get = await load();
      await expect(get()).rejects.toThrow(/SECRETS_MASTER_KEY|resolver said/);
      expect(h.state.refreshCalls).toBe(0);
      expect(h.state.updates).toEqual([]);
      if (name === "R-824 resolver") expect(JSON.stringify(err.mock.calls)).toMatch(/SECRETS_MASTER_KEY/);
    });
  }
});

// ── send path ────────────────────────────────────────────────────────────────
describe("Gmail send reads the sealed access token", () => {
  it("token-vault opens what send hands the Gmail transport", async () => {
    const { openGoogleToken } = await import("./token-vault");
    expect(openGoogleToken(encryptSecret(RAW_ACCESS))).toBe(RAW_ACCESS);
    expect(openGoogleToken(RAW_ACCESS)).toBe(RAW_ACCESS);   // legacy row
    expect(openGoogleToken(null)).toBeNull();
    const src = (await import("node:fs")).readFileSync("src/lib/email/send.ts", "utf8");
    expect(src).toMatch(/accessToken:\s*openGoogleToken\(tok\?\.access_token\)/);
  });
});
