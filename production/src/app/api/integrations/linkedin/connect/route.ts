import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import { LINKEDIN_STATE_COOKIE, LINKEDIN_STATE_TTL_MS, linkedInAuthUrl, linkedInCreds, linkedInRedirectUri } from "@/lib/integrations/linkedin/config";
import { linkedInNonce, signLinkedInState } from "@/lib/integrations/linkedin/state";
import { resolveLinkedInCaller } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const caller = await resolveLinkedInCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  if (!caller.canManage) return NextResponse.redirect(`${origin}/marketing/linkedin?linkedin=role`);
  const creds = linkedInCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/linkedin?linkedin=notconfigured`);
  const nonce = linkedInNonce();
  const state = signLinkedInState({ tenantId: caller.tenantId, userId: caller.userId, nonce }, creds.clientSecret);
  const res = NextResponse.redirect(linkedInAuthUrl(creds.clientId, linkedInRedirectUri(origin), state));
  res.cookies.set(LINKEDIN_STATE_COOKIE, nonce, { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/integrations/linkedin", maxAge: Math.floor(LINKEDIN_STATE_TTL_MS / 1000) });
  return res;
}
