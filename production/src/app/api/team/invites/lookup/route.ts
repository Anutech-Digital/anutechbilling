/**
 * POST /api/team/invites/lookup  { token }  → what the emailed invite link is for, for the
 * SIGNED-IN login (R-2517). The accept page (/invites/accept#token=…) shows it before Accept.
 *
 * No privilege of its own: the session + token go to company_invite_by_token() (SECURITY DEFINER),
 * which answers only after two-step sign-in and names the inviting company only to the invited
 * login itself. state: open | blocked (+ reason) | other_login | used | expired | not_found.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { INVITE_LINK_BROKEN_MESSAGE, readInviteToken } from "@/lib/auth/invite-link-request";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const STATES = new Set(["open", "blocked", "other_login", "used", "expired", "not_found"]);

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Sign in first, then open the invite link again." }, { status: 401, headers: NO_STORE });
  }

  const token = await readInviteToken(request);
  if (!token) {
    return NextResponse.json({ error: INVITE_LINK_BROKEN_MESSAGE }, { status: 400, headers: NO_STORE });
  }

  const rpc = supabase.rpc as unknown as (fn: "company_invite_by_token", args: { p_token: string }) =>
    PromiseLike<{ data: { state?: string; reason?: string | null; company_name?: string | null; role?: string | null; email?: string | null; expires_at?: string | null } | null; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc.call(supabase, "company_invite_by_token", { p_token: token });
  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "Couldn't open the invite right now. Try again; if it keeps failing, report it." : error.message },
      { status, headers: NO_STORE },
    );
  }
  const state = data?.state && STATES.has(data.state) ? data.state : "not_found";
  return NextResponse.json({
    state,
    /* 'blocked': why the accept would be refused, in the database's own words (with the next step) */
    reason: state === "blocked" ? data?.reason ?? null : null,
    companyName: data?.company_name ?? null,
    role: data?.role ?? null,
    email: data?.email ?? null,
    expiresAt: data?.expires_at ?? null,
    signedInAs: authData.user.email ?? null,
  }, { headers: NO_STORE });
}
