/** RFC 7591 dynamic client registration for the MCP connector (stateless — see lib/mcp/oauth/clients.ts). */
import { registerClient } from "@/lib/mcp/oauth/clients";
import { gate, json, oauthRateLimited, preflight } from "@/lib/mcp/http";
import { nowSeconds } from "@/lib/mcp/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate();
  if (!g.ok) return g.res;
  const limited = oauthRateLimited(req, "register");
  if (limited) return limited;
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 16_384) return json({ error: "invalid_client_metadata", error_description: "Request too large." }, 400);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Body must be JSON." }, 400);
  }
  const r = registerClient(body, g.secret, nowSeconds());
  if (!r.ok) return json({ error: r.error, error_description: r.description }, 400);
  return json(r.body, 201);
}

export function OPTIONS(): Response {
  return preflight();
}
