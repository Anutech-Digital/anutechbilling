/**
 * Middleware's view of the session when login runs on Auth.js — the same shape
 * src/lib/supabase/middleware.ts#updateSession returns for GoTrue, so src/middleware.ts makes
 * the same decisions (sign-in gate, /mfa redirect, role home, apprentice area) either way.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { auth } from "./authjs";

export async function authjsMiddlewareSession(request: NextRequest) {
  const response = NextResponse.next({ request });
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { response, user: null, role: null as string | null, canViewDeals: false, needsMfa: false };

  const needsMfa = session.mfaEnrolled && session.aal !== "aal2";
  const supabase = createClient();
  const { data: me } = await supabase.from("users").select("role, can_view_deals").eq("id", userId).maybeSingle();
  let role = (me?.role as string | null) ?? null;
  if (!me) {
    const { data: appr } = await supabase.from("academy_apprentices").select("id").eq("user_id", userId).maybeSingle();
    if (appr) role = "apprentice";
  }
  return { response, user: { id: userId, email: session.user.email }, role, canViewDeals: Boolean(me?.can_view_deals), needsMfa };
}
