/**
 * MCP connector switches and limits (docs/MCP.md).
 *
 * Both switches default OFF and fail closed: only "true" / "1" / "on" turns one on. With
 * MCP_ENABLED off, /api/mcp and every OAuth endpoint answer 404, so nothing is advertised.
 * MCP_WRITE_ENABLED only matters when MCP_ENABLED is on; off, write tools are not even listed.
 */

function flag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

export function mcpEnabled(): boolean {
  return flag("MCP_ENABLED");
}

export function mcpWriteEnabled(): boolean {
  return mcpEnabled() && flag("MCP_WRITE_ENABLED");
}

/** Access tokens live one hour; Claude refreshes them with the refresh token. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token (and so the connection) dies after 30 days without use. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** An authorization code must be swapped for tokens within 5 minutes. */
export const AUTH_CODE_TTL_SECONDS = 5 * 60;
/** The consent form must be submitted within 10 minutes of being shown. */
export const CONSENT_TICKET_TTL_SECONDS = 10 * 60;
/** A write preview must be confirmed within 15 minutes. */
export const PREVIEW_TTL_SECONDS = 15 * 60;

/** Tool calls one person may make per window, across all their connections (per instance). */
export const MCP_TOOL_RATE = Object.freeze({ limit: 60, windowMs: 60_000 });
/** Token / register / authorize calls per client IP per window (per instance). */
export const MCP_OAUTH_RATE = Object.freeze({ limit: 30, windowMs: 60_000 });

/** Page size limits for every list tool. */
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;

export const SCOPE_READ = "mcp:read";
export const SCOPE_WRITE = "mcp:write";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/**
 * The signing secret for client ids, codes and tokens. 32+ characters, server-only. Missing →
 * the OAuth endpoints refuse with a config error instead of signing with something guessable.
 */
export function mcpSecret(): string | null {
  const s = process.env.MCP_OAUTH_SECRET ?? "";
  return s.length >= 32 ? s : null;
}
