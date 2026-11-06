/**
 * DELETE /api/team/members/:id → "Remove from this company" (R-2477, R-2471 slice 3).
 * Spec: docs/specs/memberships.md §6.
 *
 * Like /api/team/claim and /api/team/switch-company this route holds NO privilege of its own: it
 * forwards the SESSION to the SECURITY DEFINER remove_company_member(), which decides everything in
 * Postgres for every caller — owner of the CURRENT company only (MFA step done), never yourself,
 * never the last active owner, only a member of this company. It ends that one membership; the
 * users row and every record they made stay. Its refusal text names the next step (§24) and goes
 * back unchanged.
 *
 * Why a route and not a browser rpc: the removed login's role can change with it (their selection
 * moves to another company, or to none), and the data gateway caches each login's role for a
 * minute (gateway-limits.ts) — only server code can drop that entry.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { invalidateGatewayRole } from "@/server/postgrest/gateway-limits";
import { can } from "@/lib/auth/roles";

const id = z.string().uuid();

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Your sign-in has expired. Sign in again, then remove them." }, { status: 401 });
  }

  const { id: raw } = await ctx.params;
  const parsed = id.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick the person to remove from the Team list." }, { status: 400 });
  }

  /* A fast, plain refusal for a non-owner (same flag as Team → Invite, R-1651). Not the guard —
     remove_company_member re-checks the owner's active membership + MFA in SQL. */
  const { data: me } = await supabase
    .from("users")
    .select("role, is_active")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (!me || me.is_active === false || !can(me.role, "can_manage_team")) {
    return NextResponse.json(
      { error: "Only an owner can remove someone from this company. Ask an owner to do it on the Team page." },
      { status: 403 },
    );
  }

  const rpc = supabase.rpc as unknown as (fn: "remove_company_member", args: { p_user_id: string }) =>
    PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  const { error } = await rpc.call(supabase, "remove_company_member", { p_user_id: parsed.data });
  if (error) {
    const status = error.code === "P0002" ? 404 : error.code === "42501" ? 403 : error.code === "22023" ? 400 : 500;
    return NextResponse.json(
      { error: status === 500 ? "Couldn't remove this member right now. Try again; if it keeps failing, report it." : error.message },
      { status },
    );
  }

  invalidateGatewayRole(parsed.data);
  return NextResponse.json({ ok: true });
}
