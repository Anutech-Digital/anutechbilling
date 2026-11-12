import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import { exchangeLinkedInCode } from "@/lib/integrations/linkedin/api";
import { LINKEDIN_STATE_COOKIE, linkedInCreds, linkedInRedirectUri } from "@/lib/integrations/linkedin/config";
import { validLinkedInState } from "@/lib/integrations/linkedin/state";
import { resolveLinkedInCaller, saveLinkedInConnection } from "@/lib/integrations/linkedin/store";
import { refuseConnectWithoutVault } from "@/lib/google/token-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const done = (status: string) => {
    const res = NextResponse.redirect(`${origin}/marketing/linkedin?linkedin=${status}`);
    res.cookies.set(LINKEDIN_STATE_COOKIE, "", { path: "/api/integrations/linkedin", maxAge: 0 });
    return res;
  };
  const params = new URL(request.url).searchParams;
  if (params.get("error")) return done("denied");
  const code = params.get("code");
  if (!code) return done("error");
  const creds = linkedInCreds();
  if (!creds) return done("notconfigured");
  const caller = await resolveLinkedInCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  if (!caller.canManage) return done("role");
  if (!validLinkedInState(params.get("state"), creds.clientSecret, { tenantId: caller.tenantId, userId: caller.userId, nonce: request.cookies.get(LINKEDIN_STATE_COOKIE)?.value })) return done("badstate");
  if (refuseConnectWithoutVault("linkedin/callback")) return done("novault");
  try {
    const token = await exchangeLinkedInCode(code, linkedInRedirectUri(origin), creds);
    await saveLinkedInConnection(caller.admin, caller.tenantId, caller.userId, token.accessToken, token.expiresAt);
    return done("connected");
  } catch (error) {
    console.error("[linkedin/callback] failed", error instanceof Error ? error.message : "unknown");
    return done("error");
  }
}
