/**
 * OAuth 2.1 server for the MCP connector: token signing, client registration, the authorize
 * request, code exchange (PKCE, one use), refresh rotation, revocation, and the per-call caller
 * check (deactivated / switched company / revoked connection → refused).
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type Tables } from "@/lib/mcp/__tests__/fake-db";
import { OWNER_A, TENANT_A, TENANT_B } from "@/lib/mcp/__tests__/seed";

const self = vi.hoisted(() => ({
  row: null as null | { id: string; tenant_id: string; role: string | null; is_active: boolean | null; full_name: string | null; access_ends_on: string | null },
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { userId: string; aal: string }[],
  mk: null as null | ((t: Record<string, Record<string, unknown>[]>, tenant: string) => unknown),
}));

vi.mock("@/lib/mcp/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/mcp/db")>();
  return {
    ...actual,
    readSelf: vi.fn(async (userId: string, _email: string, aal: string) => {
      self.calls.push({ userId, aal });
      return { client: {}, row: self.row, error: null };
    }),
    mcpDbFromClient: vi.fn((_c: unknown, tenantId: string) => self.mk!(self.tables, tenantId)),
  };
});

import { pkceS256Matches, signToken, verifyToken } from "@/lib/mcp/crypto";
import { isAllowedRedirectUri, readClient, registerClient } from "@/lib/mcp/oauth/clients";
import { issueTicket, parseAuthorize, readTicket } from "@/lib/mcp/oauth/consent";
import { accessClaims, createPendingGrant, exchangeCode, normaliseScope, refreshTokens, revokeToken } from "@/lib/mcp/oauth/grants";
import { resolveContext } from "@/lib/mcp/context";

self.mk = (t, tenant) => fakeDb(t as Tables, tenant);

const SECRET = "test-secret-test-secret-test-secret-0001";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(43) + "erifier-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const GRANT = "aaaaaaaa-0000-4000-8000-00000000aa01";

function client() {
  const r = registerClient({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none" }, SECRET, 1_000);
  if (!r.ok) throw new Error(r.description);
  return r.client;
}

beforeEach(() => {
  self.row = { id: OWNER_A, tenant_id: TENANT_A, role: "owner", is_active: true, full_name: "Pardeep", access_ends_on: null };
  self.tables = { mcp_oauth_grants: [], mcp_audit_log: [] };
  self.calls = [];
});

async function connect(scope = "mcp:read") {
  const c = client();
  const db = fakeDb(self.tables as Tables, TENANT_A);
  const r = await createPendingGrant(db, {
    grantId: GRANT, userId: OWNER_A, email: "owner@a.test", aal: "aal1", clientId: c.clientId, clientName: c.name,
    redirectUri: REDIRECT, scope, codeChallenge: CHALLENGE,
  }, SECRET);
  if ("error" in r) throw new Error(r.error_description);
  return { c, code: r.code };
}

describe("signed tokens", () => {
  it("round-trips and refuses tampering, another secret, or another kind", () => {
    const t = signToken("mcpat", { a: 1 }, SECRET);
    expect(verifyToken("mcpat", t, SECRET)).toEqual({ a: 1 });
    expect(verifyToken("mcpat", t, `${SECRET}x`)).toBeNull();
    expect(verifyToken("mcprt", t.replace(/^mcpat/, "mcprt"), SECRET)).toBeNull();
    const [k, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ a: 2 })).toString("base64url");
    expect(verifyToken("mcpat", `${k}.${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyToken("mcpat", `${k}.${body}.`, SECRET)).toBeNull();
  });

  it("PKCE S256 matches only the right verifier", () => {
    expect(pkceS256Matches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceS256Matches(`${VERIFIER}x`, CHALLENGE)).toBe(false);
    expect(pkceS256Matches("short", CHALLENGE)).toBe(false);
  });
});

describe("client registration", () => {
  it("issues a client id that carries its redirect URIs", () => {
    const c = client();
    expect(readClient(c.clientId, SECRET)).toMatchObject({ name: "Claude", redirectUris: [REDIRECT] });
    expect(readClient(`${c.clientId}x`, SECRET)).toBeNull();
  });

  it("refuses non-https redirects (except localhost), fragments and confidential clients", () => {
    expect(isAllowedRedirectUri("http://evil.test/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://a.test/cb#x")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(registerClient({ redirect_uris: ["https://a.test/cb"], token_endpoint_auth_method: "client_secret_post" }, SECRET, 1).ok).toBe(false);
    expect(registerClient({ redirect_uris: [] }, SECRET, 1).ok).toBe(false);
  });
});

describe("authorize request", () => {
  const base = () => ({ response_type: "code", client_id: client().clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz" });

  it("accepts a correct request", () => {
    expect(parseAuthorize(base(), SECRET, "https://app.test/api/mcp")).toMatchObject({ ok: true });
  });

  it("never redirects to an unregistered URI; sends other errors back to the client", () => {
    expect(parseAuthorize({ ...base(), redirect_uri: "https://evil.test/cb" }, SECRET, "x")).toMatchObject({ ok: false, kind: "show" });
    expect(parseAuthorize({ ...base(), client_id: "nope" }, SECRET, "x")).toMatchObject({ ok: false, kind: "show" });
    expect(parseAuthorize({ ...base(), code_challenge_method: "plain" }, SECRET, "x")).toMatchObject({ ok: false, kind: "redirect", error: "invalid_request" });
    expect(parseAuthorize({ ...base(), resource: "https://other.test/mcp" }, SECRET, "https://app.test/api/mcp")).toMatchObject({ ok: false, error: "invalid_target" });
  });

  it("consent tickets expire and pin the user", () => {
    const p = parseAuthorize(base(), SECRET, "x");
    if (!p.ok) throw new Error("setup");
    const t = issueTicket(OWNER_A, p.req, SECRET, 1_000);
    expect(readTicket(t, SECRET, 1_100)?.u).toBe(OWNER_A);
    expect(readTicket(t, SECRET, 1_000 + 601)).toBeNull();
  });
});

describe("code → tokens → refresh → revoke", () => {
  it("exchanges a code once, with PKCE, and the access token names the grant", async () => {
    const { c, code } = await connect();
    const pair = await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET);
    if ("error" in pair) throw new Error(pair.error_description);
    expect(pair.token_type).toBe("Bearer");
    expect(accessClaims(pair.access_token, SECRET)).toMatchObject({ g: GRANT, u: OWNER_A, t: TENANT_A, s: "mcp:read" });
    expect(self.tables.mcp_oauth_grants[0]).toMatchObject({ status: "active", code_hash: null });
    expect(String(self.tables.mcp_oauth_grants[0].refresh_hash)).toMatch(/^[0-9a-f]{64}$/);

    const replay = await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET);
    expect(replay).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a wrong verifier, client or redirect URI", async () => {
    const { c, code } = await connect();
    expect(await exchangeCode({ code, codeVerifier: `${VERIFIER}x`, clientId: c.clientId, redirectUri: REDIRECT }, SECRET)).toMatchObject({ error: "invalid_grant" });
    expect(await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: "https://claude.ai/other" }, SECRET)).toMatchObject({ error: "invalid_grant" });
    const other = registerClient({ redirect_uris: [REDIRECT] }, SECRET, 2);
    if (!other.ok) throw new Error("setup");
    expect(await exchangeCode({ code, codeVerifier: VERIFIER, clientId: other.client.clientId, redirectUri: REDIRECT }, SECRET)).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an expired code", async () => {
    const { c, code } = await connect();
    expect(await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET, Date.now() + 6 * 60_000)).toMatchObject({ error: "invalid_grant" });
  });

  it("rotates refresh tokens and refuses a used one", async () => {
    const { c, code } = await connect();
    const first = await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET);
    if ("error" in first) throw new Error("setup");
    const second = await refreshTokens({ refreshToken: first.refresh_token, clientId: c.clientId }, SECRET);
    if ("error" in second) throw new Error(second.error_description);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await refreshTokens({ refreshToken: first.refresh_token, clientId: c.clientId }, SECRET)).toMatchObject({ error: "invalid_grant" });
    expect(await refreshTokens({ refreshToken: second.access_token, clientId: c.clientId }, SECRET)).toMatchObject({ error: "invalid_grant" });
  });

  it("revoking any token of the connection kills refresh and every access token", async () => {
    const { c, code } = await connect();
    const pair = await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET);
    if ("error" in pair) throw new Error("setup");
    expect((await resolveContext(pair.access_token, SECRET)).ok).toBe(true);
    await revokeToken(pair.access_token, SECRET);
    expect(self.tables.mcp_oauth_grants[0]).toMatchObject({ status: "revoked", refresh_hash: null });
    expect(await refreshTokens({ refreshToken: pair.refresh_token, clientId: c.clientId }, SECRET)).toMatchObject({ error: "invalid_grant" });
    expect(await resolveContext(pair.access_token, SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it("write scope only when the switch allows it", () => {
    expect(normaliseScope("mcp:read mcp:write", false)).toBe("mcp:read");
    expect(normaliseScope("mcp:read mcp:write", true)).toBe("mcp:read mcp:write");
    expect(normaliseScope("anything", true)).toBe("mcp:read");
  });
});

describe("resolveContext — user → tenant → role, every call", () => {
  async function token(scope = "mcp:read") {
    const { c, code } = await connect(scope);
    const pair = await exchangeCode({ code, codeVerifier: VERIFIER, clientId: c.clientId, redirectUri: REDIRECT }, SECRET);
    if ("error" in pair) throw new Error("setup");
    return pair.access_token;
  }

  it("resolves the role from the users row and runs as the user with the consent-time aal", async () => {
    const t = await token("mcp:read mcp:write");
    const r = await resolveContext(t, SECRET);
    expect(r).toMatchObject({ ok: true, ctx: { userId: OWNER_A, tenantId: TENANT_A, role: "owner", canWrite: true } });
    expect(self.calls.at(-1)).toEqual({ userId: OWNER_A, aal: "aal1" });
  });

  it("refuses a deactivated user, a company switch, a personal account, and a bad token", async () => {
    const t = await token();
    self.row = { ...self.row!, is_active: false };
    expect(await resolveContext(t, SECRET)).toMatchObject({ ok: false, status: 401 });
    self.row = { ...self.row!, is_active: true, tenant_id: TENANT_B };
    expect(await resolveContext(t, SECRET)).toMatchObject({ ok: false, status: 401 });
    self.row = { ...self.row!, tenant_id: TENANT_A, role: "personal" };
    expect(await resolveContext(t, SECRET)).toMatchObject({ ok: false, status: 403 });
    self.row = { ...self.row!, role: "owner", access_ends_on: "2020-01-01" };
    expect(await resolveContext(t, SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(await resolveContext(`${t}x`, SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it("an access token past its hour is refused", async () => {
    const t = await token();
    expect(await resolveContext(t, SECRET, new Date(Date.now() + 61 * 60_000))).toMatchObject({ ok: false, status: 401 });
  });
});
