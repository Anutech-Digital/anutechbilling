/**
 * POST /api/team/invites/:id/accept → the signed-in login accepts an invite from another company
 * (R-2477 independent review — the explicit agreement Claim used to assume from a sign-in).
 * Spec: docs/specs/memberships.md §6.1.
 *
 * Like /api/team/switch-company this route holds NO privilege of its own: it forwards the SESSION
 * to the SECURITY DEFINER accept_company_invite(), which checks in Postgres that the invite is
 * addressed to this very login, is not expired, and that two-step sign-in is done. Its refusal
 * text names the next step and goes back unchanged.
 *
 * Why a route and not a browser rpc: when the accept also makes the new company the selected one,
 * this login's ROLE changes, and the data gateway caches each login's role for a minute
 * (gateway-limits.ts) — only server code can drop that entry.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { invalidateGatewayRole } from "@/server/postgrest/gateway-limits";

const id = z.string().uuid();

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Your sign-in has expired. Sign in again, then accept the invite." }, { status: 401 });
  }

  const { id: raw } = await ctx.params;
  const parsed = id.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "That invite link is not valid. Open the invite from the top of the app." }, { status: 400 });
  }

  const rpc = supabase.rpc as unknown as (fn: "accept_company_invite", args: { p_invite_id: string }) =>
    PromiseLike<{ data: { company_name?: string | null; role?: string | null; selected?: boolean } | null; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc.call(supabase, "accept_company_invite", { p_invite_id: parsed.data });
  if (error) {
    const status = error.code === "P0002" ? 404 : error.code === "42501" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "Couldn't accept the invite right now. Try again; if it keeps failing, report it." : error.message },
      { status },
    );
  }

  if (data?.selected) invalidateGatewayRole(authData.user.id);
  return NextResponse.json({
    ok: true,
    companyName: data?.company_name ?? null,
    role: data?.role ?? null,
    selected: !!data?.selected,
  });
}
