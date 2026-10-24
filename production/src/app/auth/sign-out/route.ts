/**
 * Sign-out handler — clears session and redirects to login.
 * @example <form action="/auth/sign-out" method="post"><button>Sign out</button></form>
 *
 * R-1439: the answer is a RELATIVE `Location: /login`. It used to be an absolute URL from
 * trustedOrigin(), which falls back to NEXT_PUBLIC_APP_URL for a host not on the allowlist
 * (a production build on localhost:3001 → https://…/login). The CSP's `form-action 'self'`
 * also covers the redirect after a form POST, so Chrome blocked it and "Switch account" /
 * "Sign out" looked dead. A relative Location always resolves against the origin the form was
 * posted from — no request host is ever echoed (R-723), and no internal bind address leaks.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = createClient();
  await supabase.auth.signOut();
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
