import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import { refuseConnectWithoutVault } from "@/lib/google/token-vault";
import { validLinkedInState } from "@/lib/integrations/linkedin/state";
import {
  exchangeMetaCode, facebookPageCaller, facebookPageRedirectUri, metaAppCreds, savePendingFacebookUser,
} from "@/lib/integrations/facebook-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const done = (status: string) => {
    const response = NextResponse.redirect(`${origin}/marketing/facebook?facebook=${status}`);
    response.cookies.set("facebook_page_oauth_state", "", { path: "/api/integrations/facebook-page", maxAge: 0 });
    return response;
  };
  const params = new URL(request.url).searchParams;
  if (params.get("error")) return done("denied");
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  if (!caller.canManage) return done("role");
  const creds = metaAppCreds();
  if (!creds) return done("notconfigured");
  if (!validLinkedInState(params.get("state"), creds.appSecret, {
    tenantId: caller.tenantId, userId: caller.userId, nonce: request.cookies.get("facebook_page_oauth_state")?.value,
  })) return done("badstate");
  const code = params.get("code");
  if (!code) return done("error");
  if (refuseConnectWithoutVault("facebook-page/callback")) return done("novault");
  try {
    const token = await exchangeMetaCode(code, facebookPageRedirectUri(origin), creds);
    await savePendingFacebookUser(caller.admin, caller.tenantId, token.accessToken);
    return done("choose");
  } catch (error) {
    console.error("[facebook-page/callback] failed", error instanceof Error ? error.message : "unknown");
    return done("error");
  }
}
