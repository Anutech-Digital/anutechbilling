/** RFC 7009 token revocation: revokes the whole connection the token belongs to. Always 200 (per the RFC). */
import { revokeToken } from "@/lib/mcp/oauth/grants";
import { gate, json, oauthRateLimited, preflight, readParams } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate();
  if (!g.ok) return g.res;
  const limited = oauthRateLimited(req, "revoke");
  if (limited) return limited;
  const p = await readParams(req);
  const token = p.get("token");
  if (token) await revokeToken(token, g.secret);
  return json({}, 200);
}

export function OPTIONS(): Response {
  return preflight();
}
