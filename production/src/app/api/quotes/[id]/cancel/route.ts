/**
 * POST   /api/quotes/:id/cancel  { reason }  — R-2519 Cancel (void) an unpaid quote or proforma.
 * DELETE /api/quotes/:id/cancel              — R-2519 Undo the cancel (while nothing was paid).
 *
 * The quote is KEPT (never deleted): cancel_quote closes it (stored 'rejected' + cancelled_at,
 * shown "Cancelled"), logs the reason, takes it out of reminders and awaiting payment, and leaves
 * the subscription alone — unlike "Customer stopped", which ends or pauses it. A part request
 * lets go of its part so the part can be billed again. Money roles only (mayDo money.record); the
 * RPC checks the role and the company again.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";
import { parseCancelReason } from "@/lib/billing/proforma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function gate() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { res: NextResponse.json({ error: "Please sign in again." }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return { res: NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 }) };
  if (!mayDo((me as { role?: string | null }).role, "money.record")) {
    return { res: NextResponse.json({ error: forbiddenMessage("money.record") }, { status: 403 }) };
  }
  return { supabase: supabase as unknown as SupabaseClient };
}

function refused(error: { code?: string; message: string }) {
  return NextResponse.json({ error: error.message }, { status: error.code === "42501" ? 403 : 400 });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = await gate();
  if (g.res) return g.res;
  const parsed = parseCancelReason(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { data, error } = await g.supabase.rpc("cancel_quote", { p_quote_id: params.id, p_reason: parsed.reason });
  if (error) return refused(error);
  return NextResponse.json(data);
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = await gate();
  if (g.res) return g.res;
  const { data, error } = await g.supabase.rpc("undo_cancel_quote", { p_quote_id: params.id });
  if (error) return refused(error);
  return NextResponse.json(data);
}
