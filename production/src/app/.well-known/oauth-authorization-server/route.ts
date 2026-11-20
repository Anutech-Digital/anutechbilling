/** RFC 8414 authorization server metadata for the MCP connector. 404 while MCP_ENABLED is off. */
import { authorizationServerMetadata, gate, json, preflight } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const g = gate();
  if (!g.ok) return g.res;
  return json(authorizationServerMetadata(req));
}

export function OPTIONS(): Response {
  return preflight();
}
