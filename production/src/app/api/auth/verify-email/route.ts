/**
 * POST /api/auth/verify-email  { token }  (R-048, 4 Oct 2026)
 * Confirms the email of the signup that owns this one-time token. Public by design: the token
 * IS the credential (it only exists in the email). Rate-limited per IP against guessing.
 *
 * R-822 (10 Oct 2026): this is also the moment a password signup's address becomes VERIFIED,
 * so it is where "your company already uses ResellerOS" is decided for that path. If the
 * confirmed address's domain belongs to an existing workspace (and the person has no
 * workspace of their own), a join request goes to that owner and the response carries
 * `joinRequestedTo` so the page can say so. The signup route deliberately does NOT do this
 * before verification.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { confirmEmailToken } from "@/lib/auth/email-verification";
import { routeVerifiedSignupToCompany } from "@/lib/auth/tenant-match";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";

export async function POST(request: NextRequest) {
  const rl = rateLimit(`verify-email:${clientIp(request.headers)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!rl.ok) return NextResponse.json({ ok: false, reason: "rate_limited" }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const admin = createAdminClient();
  const result = await confirmEmailToken(admin, token);
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  // Best-effort: a failure here must not turn a successful confirmation into an error.
  let joinRequestedTo: string | null = null;
  if (result.userId) {
    try {
      const { data } = await admin.auth.admin.getUserById(result.userId);
      const fullName = (data?.user?.user_metadata?.full_name as string | undefined) ?? null;
      const routed = await routeVerifiedSignupToCompany({
        authUserId: result.userId,
        email:      result.email,
        fullName,
        appUrl:     originOf(request),
      });
      joinRequestedTo = routed?.tenantName ?? null;
    } catch (e) {
      console.warn("[verify-email] company routing skipped:", (e as Error).message);
    }
  }

  return NextResponse.json({ ok: true, email: result.email, joinRequestedTo });
}

/** Public host for links in outbound alerts — never the container's internal address. */
function originOf(request: NextRequest): string {
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto   = request.headers.get("x-forwarded-proto") ?? "https";
  return fwdHost ? `${proto}://${fwdHost}` : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "");
}
