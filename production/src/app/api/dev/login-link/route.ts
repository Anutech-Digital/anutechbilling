/**
 * GET /api/dev/login-link?token_hash=…&email=…&next=/dashboard
 *
 * R-878: local-only sign-in from a one-time link made by scripts/dev/local-login-link.mjs.
 * Rules and the why: ./rules.ts. Anywhere but `npm run dev:local` on a local host it answers 404.
 * The token is single-use and expires (GoTrue otp_expiry); it is verified here, server-side,
 * the same way the demo login does (lib/demo/demo-account.server.ts#signInAs).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appPathOr } from "@/lib/safe-path";
import { loginLinkAllowed, isTestEmail, isTokenHash } from "./rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  if (!loginLinkAllowed({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    nodeEnv: process.env.NODE_ENV,
    host: request.headers.get("host"),
  })) return notFound();

  const sp = new URL(request.url).searchParams;
  const tokenHash = sp.get("token_hash");
  const email = (sp.get("email") ?? "").trim().toLowerCase();
  if (!isTokenHash(tokenHash)) {
    return NextResponse.json({ error: "Missing or malformed token." }, { status: 400, headers: noStore });
  }
  if (!isTestEmail(email)) {
    return NextResponse.json({ error: "Only @example.test accounts can use a login link." }, { status: 400, headers: noStore });
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error || !data?.user) {
    return NextResponse.json(
      { error: "Link expired or already used — run scripts/dev/local-login-link.mjs again." },
      { status: 401, headers: noStore },
    );
  }
  if ((data.user.email ?? "").toLowerCase() !== email) {
    /* The token belonged to someone else: end the session it just opened, nothing more. */
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.json({ error: "Link does not match its account." }, { status: 403, headers: noStore });
  }

  /* Relative Location: stays on the host the tester opened (tester1.localhost:3008), where the
     cookie was just set — an absolute URL built from NEXT_PUBLIC_APP_URL would drop it. */
  return new NextResponse(null, { status: 303, headers: { Location: appPathOr(sp.get("next")), ...noStore } });
}
