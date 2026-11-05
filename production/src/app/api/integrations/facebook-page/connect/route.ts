import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import { facebookPageAuthUrl, facebookPageCaller, metaAppCreds } from "@/lib/integrations/facebook-page";
import { linkedInNonce, signLinkedInState } from "@/lib/integrations/linkedin/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  if (!caller.canManage) return NextResponse.redirect(`${origin}/marketing/facebook?facebook=role`);
  const creds = metaAppCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/facebook?facebook=notconfigured`);
  const nonce = linkedInNonce();
  const state = signLinkedInState({ tenantId: caller.tenantId, userId: caller.userId, nonce }, creds.appSecret);
  const response = NextResponse.redirect(facebookPageAuthUrl(creds.appId, origin, state));
  response.cookies.set("facebook_page_oauth_state", nonce, {
    httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax",
    path: "/api/integrations/facebook-page", maxAge: 600,
  });
  return response;
}
