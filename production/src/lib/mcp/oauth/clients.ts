/**
 * Dynamic client registration (RFC 7591), stateless: the client id IS the signed registration
 * (name + redirect URIs), so nothing is stored and Cloud Run instances need no shared state.
 * Only public clients (PKCE, no client secret) — what claude.ai and MCP Inspector use.
 */
import "server-only";
import { z } from "zod";
import { signToken, verifyToken } from "@/lib/mcp/crypto";

export interface McpClient {
  clientId: string;
  name: string;
  redirectUris: string[];
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** https anywhere, or http only on this machine; no fragment, no credentials in the URL. */
export function isAllowedRedirectUri(raw: string): boolean {
  if (raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOCAL.test(u.hostname);
}

export const REGISTER_BODY = z.object({
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_name: z.string().trim().max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().max(200).optional(),
}).passthrough();

export type RegisterResult =
  | { ok: true; client: McpClient; body: Record<string, unknown> }
  | { ok: false; error: string; description: string };

export function registerClient(input: unknown, secret: string, nowSec: number): RegisterResult {
  const parsed = REGISTER_BODY.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_client_metadata", description: "redirect_uris (1–5 URLs) is required." };
  }
  const b = parsed.data;
  const bad = b.redirect_uris.find((u) => !isAllowedRedirectUri(u));
  if (bad) {
    return { ok: false, error: "invalid_redirect_uri", description: "Redirect URIs must be https (or http on localhost) with no fragment." };
  }
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") {
    return { ok: false, error: "invalid_client_metadata", description: "Only public clients are supported: token_endpoint_auth_method must be \"none\" (PKCE)." };
  }
  const name = (b.client_name ?? "").trim() || "MCP client";
  const clientId = signToken("mcpc", { n: name, r: b.redirect_uris, iat: nowSec }, secret);
  return {
    ok: true,
    client: { clientId, name, redirectUris: b.redirect_uris },
    body: {
      client_id: clientId,
      client_id_issued_at: nowSec,
      client_name: name,
      redirect_uris: b.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

/** The registered client, or null when the id is not one we signed. */
export function readClient(clientId: string | null | undefined, secret: string): McpClient | null {
  if (!clientId) return null;
  const p = verifyToken("mcpc", clientId, secret);
  if (!p || typeof p.n !== "string" || !Array.isArray(p.r)) return null;
  const uris = p.r.filter((x): x is string => typeof x === "string");
  if (uris.length === 0) return null;
  return { clientId, name: p.n.slice(0, 100), redirectUris: uris };
}

/** Exact match only (OAuth 2.1). */
export function redirectUriAllowed(client: McpClient, uri: string | null | undefined): uri is string {
  return typeof uri === "string" && client.redirectUris.includes(uri);
}
