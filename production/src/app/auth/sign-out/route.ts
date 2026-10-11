/**
 * Sign-out handler — clears session and redirects to login.
 * @example <form action="/auth/sign-out" method="post"><button>Sign out</button></form>
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  await supabase.auth.signOut();
  // Public host — never new URL(request.url).origin (Cloud Run internal bind
  // is 0.0.0.0:3000 → dead redirect), never a raw request host (R-723).
  const origin  = trustedOrigin(request.headers);
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
