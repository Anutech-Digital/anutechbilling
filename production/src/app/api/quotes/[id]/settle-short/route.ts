/**
 * POST /api/quotes/:id/settle-short — R-2606, the quote's "Settle ₹X as round-off" button.
 *
 * Runs R-2595's settle_quote_part_short with the signed-in user's own session (the RPC checks the
 * company and the role again, fail-closed): a part of a quote billed in parts received short by a
 * small difference (P7) is closed as a round-off on the receipt's bank line. Owner / accountant
 * only here too, so other roles never reach the database. The RPC's refusals are plain sentences
 * and are returned as they are; anything else is a generic message.
 *
 * Body: { reason?: string }
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  maySettleSmallShort, settleShortReason, settleShortRefusal, SETTLE_SHORT_FORBIDDEN,
} from "@/lib/quotes/settle-small-short";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  if (!maySettleSmallShort((me as { role?: string | null }).role)) {
    return NextResponse.json({ error: SETTLE_SHORT_FORBIDDEN }, { status: 403 });
  }

  const reason = settleShortReason(await req.json().catch(() => null));
  /* Untyped until the generated types know settle_quote_part_short (migration 20261108092350). */
  const { data, error } = await (supabase as unknown as SupabaseClient).rpc("settle_quote_part_short", {
    p_quote_id: params.id, p_reason: reason,
  });
  if (error) {
    const r = settleShortRefusal(error as { code?: string; message?: string });
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json(data);
}
