/**
 * Shared HTTP bits for /api/mcp and the OAuth endpoints: origin, CORS, JSON answers, and the
 * flag/secret gate every endpoint starts with.
 *
 * CORS is open (*) on these endpoints only because they never read cookies — they work from a
 * Bearer token or a public-client PKCE exchange. The consent POST (cookie session) is NOT here.
 */
import "server-only";
import { trustedOrigin } from "@/lib/app-url";
import { clientIp, rateLimit } from "@/lib/security/rate-limit";
import { MCP_OAUTH_RATE, SUPPORTED_SCOPES, mcpEnabled, mcpSecret } from "@/lib/mcp/config";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "600",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...extra },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function origin(req: Request): string {
  return trustedOrigin(req.headers);
}

export function mcpResourceUrl(req: Request): string {
  return `${origin(req)}/api/mcp`;
}

export function protectedResourceMetadataUrl(req: Request): string {
  return `${origin(req)}/.well-known/oauth-protected-resource/api/mcp`;
}

/** 404 when switched off (nothing advertised); 503 when on but the signing secret is missing. */
export function gate(): { ok: true; secret: string } | { ok: false; res: Response } {
  if (!mcpEnabled()) return { ok: false, res: json({ error: "not_found" }, 404) };
  const secret = mcpSecret();
  if (!secret) {
    return { ok: false, res: json({ error: "server_error", error_description: "The Claude connector is not configured on this server (MCP_OAUTH_SECRET missing). Tell the person who runs deploys." }, 503) };
  }
  return { ok: true, secret };
}

/** Per-IP limit on the OAuth endpoints (per instance). */
export function oauthRateLimited(req: Request, bucket: string): Response | null {
  const rl = rateLimit(`mcp-oauth:${bucket}:${clientIp(req.headers)}`, MCP_OAUTH_RATE);
  if (rl.ok) return null;
  return json({ error: "slow_down", error_description: `Too many requests — wait ${rl.retryAfterSec} seconds.` }, 429, { "Retry-After": String(rl.retryAfterSec) });
}

export function authorizationServerMetadata(req: Request): Record<string, unknown> {
  const o = origin(req);
  return {
    issuer: o,
    authorization_endpoint: `${o}/mcp/authorize`,
    token_endpoint: `${o}/api/mcp/oauth/token`,
    registration_endpoint: `${o}/api/mcp/oauth/register`,
    revocation_endpoint: `${o}/api/mcp/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
    service_documentation: `${o}/help`,
  };
}

export function protectedResourceMetadata(req: Request): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(req),
    authorization_servers: [origin(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_name: "ResellerOS",
  };
}

/** Body of a token / revoke request: form-encoded (the standard) or JSON. */
export async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  if (raw.length > 16_384) return new URLSearchParams();
  if (type.includes("application/json")) {
    try {
      const o: unknown = JSON.parse(raw);
      const p = new URLSearchParams();
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (typeof v === "string") p.set(k, v);
      return p;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}
