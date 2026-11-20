/**
 * RFC 9728 protected resource metadata. Answers both /.well-known/oauth-protected-resource and
 * /.well-known/oauth-protected-resource/api/mcp (the path-suffixed form MCP clients try first).
 */
import { gate, json, preflight, protectedResourceMetadata } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const g = gate();
  if (!g.ok) return g.res;
  return json(protectedResourceMetadata(req));
}

export function OPTIONS(): Response {
  return preflight();
}
