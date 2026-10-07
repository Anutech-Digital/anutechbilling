/**
 * R-051 part 2 — Google refresh tokens encrypted at rest.
 *
 * Proves: seal/open round-trip; legacy plaintext rows still work and get sealed on
 * the next write; no master key = refuse (never plaintext); the Gmail connect
 * callback stores ciphertext only; refreshAccessToken sends Google the REAL token;
 * status routes never return the token (plain or sealed) to the browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { isEncrypted, VaultNotConfiguredError, encryptSecret } from "@/lib/crypto/vault";
import {
  sealRefreshToken, openRefreshToken, resealIfPlain, refuseConnectWithoutVault,
} from "./token-vault";

const PLAIN = "1//0gREFRESH-token-abcdefghijklmnop";

const h = vi.hoisted(() => {
  const state = {
    tokenRow: null as Record<string, unknown> | null,
    upserts: [] as Record<string, unknown>[],
    exchanged: 0,
  };
  class Q {
    constructor(private table: string) {}
    select() { return this; }
    eq() { return this; }
    async maybeSingle() {
      if (this.table === "users") return { data: { tenant_id: "T1" }, error: null };
      if (this.table === "user_google_tokens") return { data: state.tokenRow, error: null };
      return { data: null, error: null };
    }
    async upsert(row: Record<string, unknown>) { state.upserts.push(row); return { error: null }; }
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) },
    from: (t: string) => new Q(t),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => h.client, createAdminClient: () => h.client }));
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("./oauth")>();
  return {
    ...real,
    googleOAuthCreds: () => ({ clientId: "cid", clientSecret: "csecret" }),
    fetchGoogleEmail: async () => "owner@example.com",
    exchangeCode: async () => {
      h.state.exchanged++;
      return {
        access_token: "ya29.access", refresh_token: PLAIN, expires_in: 3600,
        scope: "openid email https://www.googleapis.com/auth/gmail.send",
      };
    },
  };
});

const KEY = crypto.randomBytes(32).toString("base64");
let originalKey: string | undefined;
beforeEach(() => {
  originalKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = KEY;
  h.state.tokenRow = null;
  h.state.upserts = [];
  h.state.exchanged = 0;
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = originalKey;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("token-vault helpers", () => {
  it("round-trips: sealed value is an envelope without the token in it", () => {
    const sealed = sealRefreshToken(PLAIN);
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain(PLAIN);
    expect(openRefreshToken(sealed)).toBe(PLAIN);
  });

  it("does not double-wrap an already sealed value", () => {
    const sealed = sealRefreshToken(PLAIN);
    expect(sealRefreshToken(sealed)).toBe(sealed);
  });

  it("reads a legacy plaintext row unchanged", () => {
    expect(openRefreshToken(PLAIN)).toBe(PLAIN);
    expect(openRefreshToken(null)).toBeNull();
  });

  it("resealIfPlain upgrades legacy plaintext, leaves sealed/absent alone", () => {
    const patch = resealIfPlain(PLAIN);
    expect(isEncrypted(patch.refresh_token ?? "")).toBe(true);
    expect(openRefreshToken(patch.refresh_token)).toBe(PLAIN);
    expect(resealIfPlain(sealRefreshToken(PLAIN))).toEqual({});
    expect(resealIfPlain(null)).toEqual({});
  });

  it("no master key: sealing REFUSES, reseal is a no-op, legacy reads still work", () => {
    delete process.env.SECRETS_MASTER_KEY;
    expect(() => sealRefreshToken(PLAIN)).toThrow(VaultNotConfiguredError);
    expect(resealIfPlain(PLAIN)).toEqual({});
    expect(openRefreshToken(PLAIN)).toBe(PLAIN);
  });

  it("refuseConnectWithoutVault logs the variable name, never a value", () => {
    expect(refuseConnectWithoutVault("x")).toBe(false);
    delete process.env.SECRETS_MASTER_KEY;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(refuseConnectWithoutVault("google-gmail/callback")).toBe(true);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/SECRETS_MASTER_KEY/);
    expect(JSON.stringify(err.mock.calls)).not.toContain(KEY);
  });
});

describe("refreshAccessToken opens the stored value server-side", () => {
  const sentTokens = () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)).get("refresh_token") ?? "");
      return new Response(JSON.stringify({ access_token: "ya29.new", expires_in: 3600 }), { status: 200 });
    }));
    return sent;
  };

  it("sends Google the real token for a sealed row", async () => {
    const { refreshAccessToken } = await import("./oauth");
    const sent = sentTokens();
    await refreshAccessToken(sealRefreshToken(PLAIN), { clientId: "c", clientSecret: "s" });
    expect(sent).toEqual([PLAIN]);
  });

  it("still works for a legacy plaintext row", async () => {
    const { refreshAccessToken } = await import("./oauth");
    const sent = sentTokens();
    await refreshAccessToken(PLAIN, { clientId: "c", clientSecret: "s" });
    expect(sent).toEqual([PLAIN]);
  });

  it("a sealed row with the key missing fails locally, before calling Google", async () => {
    const { refreshAccessToken } = await import("./oauth");
    const sealed = sealRefreshToken(PLAIN);
    delete process.env.SECRETS_MASTER_KEY;
    const sent = sentTokens();
    await expect(refreshAccessToken(sealed, { clientId: "c", clientSecret: "s" })).rejects.toThrow(/SECRETS_MASTER_KEY/);
    expect(sent).toEqual([]);
  });
});

function callbackReq() {
  return new NextRequest("http://localhost:3000/api/integrations/google-gmail/callback?code=C1&state=S1", {
    headers: { cookie: "g_gmail_oauth_state=S1" },
  });
}

describe("Gmail connect callback", () => {
  it("stores the refresh token ENCRYPTED, never the plain token", async () => {
    const { GET } = await import("@/app/api/integrations/google-gmail/callback/route");
    const res = await GET(callbackReq());
    expect(res.headers.get("location")).toContain("gmail=connected");
    expect(h.state.upserts).toHaveLength(1);
    const stored = String(h.state.upserts[0].refresh_token);
    expect(isEncrypted(stored)).toBe(true);
    expect(JSON.stringify(h.state.upserts)).not.toContain(PLAIN);
    expect(openRefreshToken(stored)).toBe(PLAIN);
    expect(res.headers.get("location")).not.toContain(PLAIN);
  });

  it("no master key: refuses before exchanging the code, stores nothing", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/integrations/google-gmail/callback/route");
    const res = await GET(callbackReq());
    expect(res.headers.get("location")).toContain("gmail=vault_missing");
    expect(h.state.exchanged).toBe(0);
    expect(h.state.upserts).toEqual([]);
  });
});

describe("status routes never return the token to the browser", () => {
  const routes = [
    ["google-gmail", () => import("@/app/api/integrations/google-gmail/route")],
    ["google-contacts", () => import("@/app/api/integrations/google-contacts/route")],
  ] as const;

  for (const [name, load] of routes) {
    for (const kind of ["sealed", "legacy plaintext"] as const) {
      it(`${name} GET with a ${kind} row: says connected, carries no token`, async () => {
        const stored = kind === "sealed" ? encryptSecret(PLAIN) : PLAIN;
        h.state.tokenRow = {
          google_email: "owner@example.com", refresh_token: stored, last_error: null, last_synced_at: null,
          scopes: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/contacts",
        };
        const { GET } = await load();
        const res = await GET();
        const text = await res.text();
        expect(JSON.parse(text).connected).toBe(true);
        expect(text).not.toContain(PLAIN);
        expect(text).not.toContain("rosv1");
        expect(text).not.toContain(String(stored).slice(6, 30));
      });
    }
  }
});
