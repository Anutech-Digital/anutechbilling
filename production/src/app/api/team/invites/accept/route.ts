/**
 * POST /api/team/invites/accept  { token }  → the signed-in login accepts an invite from another
 * company with the token from the invite EMAIL (R-2517 — proof of the invited mailbox; was
 * /api/team/invites/:id/accept with the login alone, R-2477). Spec: docs/specs/memberships.md §6.3.
 *
 * Like /api/team/switch-company this route holds NO privilege of its own: it forwards the SESSION
 * and the token to the SECURITY DEFINER accept_company_invite_by_token(), which checks in Postgres
 * that the token's invite is addressed to this very login, is open (not used / expired / replaced),
 * that two-step sign-in is done and the sender is still an owner. Its refusal text names the next
 * step and goes back unchanged. The token travels in the body (never logged, never in a response).
 *
 * Why a route and not a browser rpc: when the accept also makes the new company the selected one,
 * this login's ROLE changes, and the data gateway caches each login's role for a minute
 * (gateway-limits.ts) — only server code can drop that entry.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invalidateGatewayRole } from "@/server/postgrest/gateway-limits";
import { INVITE_LINK_BROKEN_MESSAGE, readInviteToken } from "@/lib/auth/invite-link-request";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Your sign-in has expired. Sign in again, then open the invite link again." }, { status: 401, headers: NO_STORE });
  }

  const token = await readInviteToken(request);
  if (!token) {
    return NextResponse.json({ error: INVITE_LINK_BROKEN_MESSAGE }, { status: 400, headers: NO_STORE });
  }

  const rpc = supabase.rpc as unknown as (fn: "accept_company_invite_by_token", args: { p_token: string }) =>
    PromiseLike<{ data: { tenant_id?: string | null; company_name?: string | null; role?: string | null; selected?: boolean } | null; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc.call(supabase, "accept_company_invite_by_token", { p_token: token });
  if (error) {
    const status = error.code === "P0002" ? 404 : error.code === "42501" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "Couldn't accept the invite right now. Try again; if it keeps failing, report it." : error.message },
      { status, headers: NO_STORE },
    );
  }

  if (data?.selected) invalidateGatewayRole(authData.user.id);
  return NextResponse.json({
    ok: true,
    /* the joined company (so the page can offer "Switch to it now") — the login is a member there now */
    tenantId: data?.tenant_id ?? null,
    companyName: data?.company_name ?? null,
    role: data?.role ?? null,
    selected: !!data?.selected,
  }, { headers: NO_STORE });
}
