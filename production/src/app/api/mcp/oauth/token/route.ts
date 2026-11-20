/** OAuth 2.1 token endpoint: authorization_code (PKCE S256) and refresh_token (rotating). Public clients only. */
import { readClient } from "@/lib/mcp/oauth/clients";
import { exchangeCode, refreshTokens } from "@/lib/mcp/oauth/grants";
import { gate, json, oauthRateLimited, preflight, readParams } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate();
  if (!g.ok) return g.res;
  const limited = oauthRateLimited(req, "token");
  if (limited) return limited;
  const p = await readParams(req);
  const client = readClient(p.get("client_id"), g.secret);
  if (!client) return json({ error: "invalid_client", error_description: "Unknown client_id — register the client first." }, 401);

  const grantType = p.get("grant_type");
  let r;
  if (grantType === "authorization_code") {
    const code = p.get("code"); const verifier = p.get("code_verifier"); const redirectUri = p.get("redirect_uri");
    if (!code || !verifier || !redirectUri) return json({ error: "invalid_request", error_description: "code, code_verifier and redirect_uri are required." }, 400);
    r = await exchangeCode({ code, codeVerifier: verifier, clientId: client.clientId, redirectUri }, g.secret);
  } else if (grantType === "refresh_token") {
    const rt = p.get("refresh_token");
    if (!rt) return json({ error: "invalid_request", error_description: "refresh_token is required." }, 400);
    r = await refreshTokens({ refreshToken: rt, clientId: client.clientId }, g.secret);
  } else {
    return json({ error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token." }, 400);
  }
  if ("error" in r) return json(r, r.error === "server_error" ? 503 : 400);
  return json(r, 200);
}

export function OPTIONS(): Response {
  return preflight();
}
