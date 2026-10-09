/**
 * GET /api/auth/supabase-token — a 10-minute session token for the signed-in Auth.js user, in
 * the format GoTrue used to issue, so the browser's supabase-js keeps reaching the data gateway
 * and Storage unchanged (src/server/auth/supabase-jwt.ts). Same-origin only (no CORS headers);
 * signed out → { access_token: null }.
 *
 * R-528: never the Google provider token — this answer is read by the browser. Routes that call
 * Google read it server-side (compat.ts currentProviderToken via supabase.auth.getSession()).
 */
import { authjsOff, noStore } from "@/server/auth/http";
import { currentAuthUser } from "@/server/auth/compat";
import { mintSupabaseJwt } from "@/server/auth/supabase-jwt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const off = authjsOff();
  if (off) return off;
  const me = await currentAuthUser();
  if (!me) return noStore({ access_token: null, user: null });
  const { token, expiresAt } = mintSupabaseJwt({ userId: me.user.id, email: me.user.email, aal: me.aal });
  return noStore({
    access_token: token, expires_at: expiresAt, user: me.user,
    aal: me.aal, mfa_enrolled: me.mfaEnrolled,
  });
}
