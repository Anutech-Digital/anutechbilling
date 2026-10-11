/**
 * POST /api/auth/resend-verification  { email }  (R-048, 4 Oct 2026)
 * Sends a fresh verification link to an UNCONFIRMED password signup. Always answers the same
 * way, whether or not the address has an account, so it cannot be used to find out who has
 * signed up. Rate-limited per IP and per address.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/server";
import { startEmailVerification } from "@/lib/auth/email-verification";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";
import { normalizeEmail } from "@/lib/auth/membership";

const SAME_ANSWER = { ok: true, message: "If that address has an unconfirmed account, a new link is on its way." };

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email || !email.includes("@") || email.length > 200) return NextResponse.json(SAME_ANSWER);

  const ipOk = rateLimit(`resend-verify:ip:${clientIp(request.headers)}`, { limit: 5, windowMs: 60 * 60_000 }).ok;
  const mailOk = rateLimit(`resend-verify:mail:${email}`, { limit: 3, windowMs: 60 * 60_000 }).ok;
  if (!ipOk || !mailOk) return NextResponse.json(SAME_ANSWER);

  const admin = createAdminClient();
  // The app's own users table carries the auth id; an unconfirmed signup always has a row
  // there (created) or a join request (pending) — look the auth user up through either.
  const { data: u } = await admin.from("users").select("id, full_name").eq("email", email).maybeSingle();
  let userId: string | null = (u as { id?: string } | null)?.id ?? null;
  let name = (u as { full_name?: string } | null)?.full_name ?? "";
  if (!userId) {
    const { data: jr } = await admin.from("join_requests").select("auth_user_id, full_name")
      .eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
    userId = (jr as { auth_user_id?: string } | null)?.auth_user_id ?? null;
    name = (jr as { full_name?: string } | null)?.full_name ?? name;
  }
  if (!userId) return NextResponse.json(SAME_ANSWER);

  const { data: au } = await admin.auth.admin.getUserById(userId);
  if (!au?.user || au.user.email_confirmed_at) return NextResponse.json(SAME_ANSWER);

  // R-723: never the raw Host / X-Forwarded-Host — a forged one sent the token to the attacker.
  const origin = trustedOrigin(request.headers);
  await startEmailVerification(admin, { userId, email, name, origin });
  return NextResponse.json(SAME_ANSWER);
}
