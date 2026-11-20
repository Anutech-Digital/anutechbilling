/**
 * One row in mcp_oauth_grants = one "connection" (one Claude connector for one person).
 *
 * Tokens are signed envelopes (crypto.ts) that NAME the grant and the user; the grant row is
 * the switch. Every MCP call re-reads it as that user (RLS), so revoking a connection stops it
 * on the very next call — no waiting for the access token to expire.
 *
 *   authorization code  mcpcode.{g,u,e,t,a,s,exp,n}.sig   stored as sha256 → one use (pending → active)
 *   refresh token       mcprt.{g,u,e,t,a,s,n}.sig          stored as sha256 → rotated on every use
 *   access token        mcpat.{g,u,e,t,a,s,exp}.sig        not stored; 1 hour; grant checked per call
 *
 * aal and scope are read from the SIGNED token, never from the row — a user editing their own
 * row cannot widen what a token may do.
 */
import "server-only";
import { z } from "zod";
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, SCOPE_READ, SCOPE_WRITE,
} from "@/lib/mcp/config";
import { nowSeconds, pkceS256Matches, randomToken, safeEqual, sha256Hex, signToken, verifyToken } from "@/lib/mcp/crypto";
import { mcpDbFromClient, readSelf, type McpDb } from "@/lib/mcp/db";

export const TOKEN_CLAIMS = z.object({
  g: z.string().uuid(),
  u: z.string().uuid(),
  e: z.string().max(320),
  t: z.string().uuid(),
  a: z.enum(["aal1", "aal2"]),
  s: z.string().max(100),
  exp: z.number().int().optional(),
});
export type TokenClaims = z.infer<typeof TOKEN_CLAIMS>;

export interface TokenPair {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type OAuthError = { error: "invalid_grant" | "invalid_request" | "invalid_client" | "server_error"; error_description: string };

/** Scopes this connection may hold: read always, write only if asked for. */
export function normaliseScope(requested: string | null | undefined, writeAllowed: boolean): string {
  const asked = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  return writeAllowed && asked.has(SCOPE_WRITE) ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

export function claimsOf(kind: "mcpcode" | "mcprt" | "mcpat", token: string, secret: string): TokenClaims | null {
  const p = verifyToken(kind, token, secret);
  if (!p) return null;
  const c = TOKEN_CLAIMS.safeParse(p);
  return c.success ? c.data : null;
}

/** McpDb running as the user named in a verified token. */
async function dbFor(c: TokenClaims): Promise<{ db: McpDb } | OAuthError> {
  const self = await readSelf(c.u, c.e, c.a);
  if (self.error) return { error: "server_error", error_description: "Could not read your account. Try again in a minute." };
  if (!self.row || self.row.is_active === false || self.row.tenant_id !== c.t) {
    return { error: "invalid_grant", error_description: "This connection no longer matches your account (deactivated, or you switched company). Connect again." };
  }
  return { db: mcpDbFromClient(self.client, c.t) };
}

interface GrantRow {
  id: string; user_id: string; client_id: string; redirect_uri: string; status: string;
  code_hash: string | null; code_challenge: string | null; code_expires_at: string | null;
  refresh_hash: string | null; refresh_expires_at: string | null;
}
const GRANT_COLS = [
  "id", "user_id", "client_id", "redirect_uri", "status", "code_hash", "code_challenge", "code_expires_at",
  "refresh_hash", "refresh_expires_at",
] as const;

async function readGrant(db: McpDb, id: string): Promise<GrantRow | null> {
  const r = await db.select<GrantRow>("mcp_oauth_grants", GRANT_COLS).eq("id", id);
  return r.data?.[0] ?? null;
}

function issuePair(c: Omit<TokenClaims, "exp">, secret: string, nowSec: number): { pair: TokenPair; refreshHash: string } {
  const access = signToken("mcpat", { ...c, exp: nowSec + ACCESS_TOKEN_TTL_SECONDS }, secret);
  const refresh = signToken("mcprt", { ...c, n: randomToken(16) }, secret);
  return {
    pair: { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: c.s },
    refreshHash: sha256Hex(refresh),
  };
}

/** Consent given: write the pending grant (as the signed-in user) and return the one-use code. */
export async function createPendingGrant(db: McpDb, input: {
  grantId: string; userId: string; email: string; aal: "aal1" | "aal2"; clientId: string; clientName: string;
  redirectUri: string; scope: string; codeChallenge: string;
}, secret: string, nowMs: number = Date.now()): Promise<{ code: string } | OAuthError> {
  const nowSec = nowSeconds(nowMs);
  const code = signToken("mcpcode", {
    g: input.grantId, u: input.userId, e: input.email, t: db.tenantId, a: input.aal, s: input.scope,
    exp: nowSec + AUTH_CODE_TTL_SECONDS, n: randomToken(16),
  }, secret);
  const r = await db.insert("mcp_oauth_grants", {
    id: input.grantId,
    user_id: input.userId,
    client_id: input.clientId,
    client_name: input.clientName,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    aal: input.aal,
    status: "pending",
    code_hash: sha256Hex(code),
    code_challenge: input.codeChallenge,
    code_expires_at: new Date((nowSec + AUTH_CODE_TTL_SECONDS) * 1000).toISOString(),
  }, ["id"]);
  if (r.error) return { error: "server_error", error_description: `Could not save the connection: ${r.error.message}` };
  return { code };
}

/** authorization_code grant. */
export async function exchangeCode(input: {
  code: string; codeVerifier: string; clientId: string; redirectUri: string;
}, secret: string, nowMs: number = Date.now()): Promise<TokenPair | OAuthError> {
  const nowSec = nowSeconds(nowMs);
  const c = claimsOf("mcpcode", input.code, secret);
  if (!c || !c.exp || c.exp < nowSec) return { error: "invalid_grant", error_description: "The code is invalid or expired. Connect again." };
  const got = await dbFor(c);
  if ("error" in got) return got;
  const g = await readGrant(got.db, c.g);
  if (!g || g.status !== "pending" || !g.code_hash || !safeEqual(g.code_hash, sha256Hex(input.code))) {
    return { error: "invalid_grant", error_description: "The code was already used or is unknown. Connect again." };
  }
  if (g.client_id !== input.clientId || g.redirect_uri !== input.redirectUri) {
    return { error: "invalid_grant", error_description: "client_id or redirect_uri does not match the authorization request." };
  }
  if (!g.code_challenge || !pkceS256Matches(input.codeVerifier, g.code_challenge)) {
    return { error: "invalid_grant", error_description: "PKCE check failed (code_verifier)." };
  }
  const base = { g: c.g, u: c.u, e: c.e, t: c.t, a: c.a, s: c.s };
  const { pair, refreshHash } = issuePair(base, secret, nowSec);
  /* Compare-and-set on the code hash: a second exchange of the same code changes no row. */
  const upd = await got.db.updateWhere("mcp_oauth_grants", { id: c.g, status: "pending", code_hash: g.code_hash }, {
    status: "active", code_hash: null, refresh_hash: refreshHash,
    refresh_expires_at: new Date((nowSec + REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    last_used_at: new Date(nowMs).toISOString(),
  }, ["id"]);
  if (upd.error) return { error: "server_error", error_description: upd.error.message };
  if (!upd.data || upd.data.length !== 1) return { error: "invalid_grant", error_description: "The code was already used. Connect again." };
  return pair;
}

/** refresh_token grant — rotates the refresh token. */
export async function refreshTokens(input: { refreshToken: string; clientId: string }, secret: string, nowMs: number = Date.now()): Promise<TokenPair | OAuthError> {
  const nowSec = nowSeconds(nowMs);
  const c = claimsOf("mcprt", input.refreshToken, secret);
  if (!c) return { error: "invalid_grant", error_description: "Unknown refresh token. Connect again." };
  const got = await dbFor(c);
  if ("error" in got) return got;
  const g = await readGrant(got.db, c.g);
  const hash = sha256Hex(input.refreshToken);
  if (!g || g.status !== "active" || !g.refresh_hash || !safeEqual(g.refresh_hash, hash)) {
    return { error: "invalid_grant", error_description: "This connection was revoked or the refresh token was already used. Connect again." };
  }
  if (g.client_id !== input.clientId) return { error: "invalid_grant", error_description: "client_id does not match this connection." };
  if (g.refresh_expires_at && Date.parse(g.refresh_expires_at) < nowMs) {
    return { error: "invalid_grant", error_description: "The connection was unused for 30 days and expired. Connect again." };
  }
  const { pair, refreshHash } = issuePair({ g: c.g, u: c.u, e: c.e, t: c.t, a: c.a, s: c.s }, secret, nowSec);
  const upd = await got.db.updateWhere("mcp_oauth_grants", { id: c.g, status: "active", refresh_hash: g.refresh_hash }, {
    refresh_hash: refreshHash,
    refresh_expires_at: new Date((nowSec + REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    last_used_at: new Date(nowMs).toISOString(),
  }, ["id"]);
  if (upd.error) return { error: "server_error", error_description: upd.error.message };
  if (!upd.data || upd.data.length !== 1) return { error: "invalid_grant", error_description: "The refresh token was already used. Connect again." };
  return pair;
}

/** RFC 7009: revoke the connection a refresh or access token belongs to. Unknown tokens are ignored. */
export async function revokeToken(token: string, secret: string, nowMs: number = Date.now()): Promise<void> {
  const c = claimsOf("mcprt", token, secret) ?? claimsOf("mcpat", token, secret);
  if (!c) return;
  const got = await dbFor(c);
  if ("error" in got) return;
  await revokeGrant(got.db, c.g, nowMs);
}

export async function revokeGrant(db: McpDb, grantId: string, nowMs: number = Date.now()): Promise<boolean> {
  const r = await db.updateById("mcp_oauth_grants", grantId, {
    status: "revoked", revoked_at: new Date(nowMs).toISOString(), refresh_hash: null, code_hash: null,
  }, ["id"]);
  return !r.error && !!r.data;
}

/** Access-token check for /api/mcp: signature + expiry only; the grant row is checked by the caller. */
export function accessClaims(token: string, secret: string, nowMs: number = Date.now()): TokenClaims | null {
  const c = claimsOf("mcpat", token, secret);
  if (!c || !c.exp || c.exp < nowSeconds(nowMs)) return null;
  return c;
}
