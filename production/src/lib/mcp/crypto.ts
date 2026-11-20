/**
 * Signing helpers for the MCP OAuth server. HMAC-SHA256 over a base64url JSON payload; every
 * token type carries its own prefix inside the signed text, so a refresh token can never be
 * replayed as an access token (or a client id as either).
 */
import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenKind = "mcpc" | "mcpcode" | "mcpat" | "mcprt" | "mcpct";

export function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex — how codes and refresh secrets are stored (never in clear). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sig(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("base64url");
}

/** `<kind>.<payload>.<sig>` — the kind is part of what is signed. */
export function signToken(kind: TokenKind, payload: Record<string, unknown>, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${kind}.${body}.${sig(secret, `${kind}.${body}`)}`;
}

/** The payload when the token is ours, of this kind, and untampered; otherwise null. */
export function verifyToken(kind: TokenKind, token: string, secret: string): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== kind) return null;
  if (!safeEqual(parts[2], sig(secret, `${parts[0]}.${parts[1]}`))) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceS256Matches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

export function nowSeconds(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000);
}
