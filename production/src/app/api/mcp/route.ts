/**
 * /api/mcp — the remote MCP server (Streamable HTTP, stateless: a fresh server per request).
 * Off unless MCP_ENABLED; every call needs a Bearer access token from our OAuth flow
 * (docs/MCP.md). Logic lives in src/lib/mcp.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveContext } from "@/lib/mcp/context";
import { gate, json, preflight, protectedResourceMetadataUrl, CORS_HEADERS } from "@/lib/mcp/http";
import { buildServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(req: Request, status: 401 | 403 | 503, message: string, code: "invalid_token" | "insufficient_scope" | "temporarily_unavailable" = "invalid_token"): Response {
  const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(req)}"${status === 401 ? `, error="${code}", error_description="${message.replace(/"/g, "'")}"` : ""}`;
  return json({ error: code, error_description: message }, status, { "WWW-Authenticate": challenge });
}

async function handle(req: Request): Promise<Response> {
  const g = gate();
  if (!g.ok) return g.res;
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return unauthorized(req, 401, "Sign in to ResellerOS to use this connector.");
  const resolved = await resolveContext(m[1], g.secret);
  if (!resolved.ok) return unauthorized(req, resolved.status, resolved.error, resolved.status === 503 ? "temporarily_unavailable" : "invalid_token");

  const server = buildServer(resolved.ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export function OPTIONS(): Response {
  return preflight();
}
