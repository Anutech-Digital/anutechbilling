/**
 * POST /api/team/switch-company  { tenantId }  → work in another company this login belongs to
 * (R-2476, R-2471 slice 2 — spec docs/specs/memberships.md §2.5 / §5).
 *
 * Like /api/team/claim this route holds NO privilege of its own: it forwards the SESSION to the
 * SECURITY DEFINER switch_company(), which decides membership, end date and two-step sign-in in
 * Postgres for every caller. Its refusal text already names the next step (§24) and goes back
 * unchanged.
 *
 * Why a route and not a browser rpc: after the switch this login's ROLE changes with its company,
 * and the data gateway caches each login's role for a minute (gateway-limits.ts gatewayRole —
 * contact masking R-1009, row/rate limits R-1005). The switch must drop that cache entry, which
 * only server code can do. (Per server instance: another Cloud Run instance keeps its entry up to
 * its 60 s TTL — see the card's review.left.)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { invalidateGatewayRole } from "@/server/postgrest/gateway-limits";

const PICK = "Pick a company from the list in the top bar.";
const schema = z.object({
  tenantId: z.string({ required_error: PICK, invalid_type_error: PICK }).uuid(PICK),
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Your sign-in has expired. Sign in again, then switch company." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body && typeof body === "object" ? body : {});
  if (!parsed.success) {
    return NextResponse.json({ error: PICK }, { status: 400 });
  }

  const rpc = supabase.rpc as unknown as (fn: "switch_company", args: { p_tenant_id: string }) =>
    PromiseLike<{ data: string | null; error: { message: string } | null }>;
  const { data, error } = await rpc.call(supabase, "switch_company", { p_tenant_id: parsed.data.tenantId });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }

  invalidateGatewayRole(authData.user.id);
  return NextResponse.json({ ok: true, tenantId: data ?? parsed.data.tenantId });
}
