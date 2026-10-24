/**
 * POST /api/auth/login-event   (no body)
 *
 * R-1010: record the current sign-in on the server. With GoTrue (live today) the password /
 * Google check happens at GoTrue, so the app first sees a new sign-in when the signed-in
 * browser loads; the topbar calls this once per tab session. Everything recorded comes from
 * the server's side: the user and the sign-in time from GoTrue (getUser → last_sign_in_at),
 * the IP from the trusted proxy hop, the device from the User-Agent header. The body is ignored.
 * A once-per-sign-in unique index (migration 20261023173100) makes repeat calls a no-op.
 *
 * With Auth.js the sign-in was already recorded inside the auth flow (src/server/auth/authjs.ts),
 * so this answers ok and writes nothing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authProvider } from "@/server/auth/authjs";
import { recordLogin } from "@/server/auth/login-log";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { data } = await createClient().auth.getUser();
  const user = data?.user;
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  if (authProvider() === "authjs") return NextResponse.json({ ok: true });

  const signedInAt = user.last_sign_in_at ?? null;
  if (signedInAt) {
    await recordLogin({ userId: user.id, headers: request.headers, method: "session", signedInAt });
  }
  return NextResponse.json({ ok: true });
}
