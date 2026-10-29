/**
 * POST /api/quotes/:id/customer-stopped — R-2044 "Customer stopped".
 *
 * For an UNPAID payment request of one part of a subscription billed in parts: the customer broke
 * the commitment and will not pay. The request is closed (rejected) and the subscription is
 * cancelled or paused — in ONE database call, stop_part_payment_request, which reuses
 * cancel_subscription / suspend_subscription. Nothing was invoiced for that part, so nothing is
 * left in GST or receivables.
 *
 * Runs with the signed-in user's own session: money roles only here (mayDo money.record), and the
 * RPC narrows it to owner / manager / accountant (who may cancel a subscription) and the company.
 *
 * Body: { end: "cancel" | "pause"; reason: string }
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { parseCustomerStopped } from "@/lib/billing/part-requests";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  /* Money roles first (R-718); the RPC then allows only owner / manager / accountant — the roles
     that may cancel a subscription — and checks the company. */
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  if (!mayDo((me as { role?: string | null }).role, "money.record")) {
    return NextResponse.json({ error: forbiddenMessage("money.record") }, { status: 403 });
  }

  const parsed = parseCustomerStopped(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  /* Untyped until the generated types know stop_part_payment_request (migration 20261028025317). */
  const { data, error } = await (supabase as unknown as SupabaseClient).rpc("stop_part_payment_request", {
    p_quote_id: params.id, p_end: parsed.end, p_reason: parsed.reason,
  });
  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json(data);
}
