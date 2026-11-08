/**
 * /api/quotes/:id/settle-short — R-2606, the quote's "Settle ₹X as round-off" button.
 *
 * GET  → what would be settled: { amount, invoiceId, bankLine } read the way R-2595's RPC picks it
 *        (earliest open part invoice, the latest receipt's bank line), or null when nothing is.
 * POST { expected, reason? } → runs settle_quote_part_short with the signed-in user's own session
 *        (the RPC checks the company and the role again, fail-closed). Refused with 409 when the
 *        amount the owner confirmed is no longer the part's difference — never books a figure the
 *        owner did not see. The RPC's refusals are plain sentences and are returned as they are;
 *        anything else is logged and answered with a generic message.
 *
 * Owner / accountant only, so other roles never reach the database.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  maySettleSmallShort, settleShortPreview, settleShortReason, settleShortRefusal, SETTLE_SHORT_FORBIDDEN, SETTLE_SHORT_GENERIC,
} from "@/lib/quotes/settle-small-short";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Gate = { ok: true; supabase: ReturnType<typeof createClient> } | { ok: false; res: NextResponse };

async function gate(): Promise<Gate> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Please sign in again." }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return { ok: false, res: NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 }) };
  if (!maySettleSmallShort((me as { role?: string | null }).role)) {
    return { ok: false, res: NextResponse.json({ error: SETTLE_SHORT_FORBIDDEN }, { status: 403 }) };
  }
  return { ok: true, supabase };
}

function readFailed(e: unknown) {
  console.error("[settle-short] preview read failed", e);
  return NextResponse.json({ error: SETTLE_SHORT_GENERIC }, { status: 500 });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = await gate();
  if (!g.ok) return g.res;
  try {
    return NextResponse.json({ preview: await settleShortPreview(g.supabase as never, params.id) });
  } catch (e) {
    return readFailed(e);
  }
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = await gate();
  if (!g.ok) return g.res;
  const supabase = g.supabase;

  const body = await req.json().catch(() => null);
  const expected = Number((body as { expected?: unknown } | null)?.expected);
  if (!Number.isFinite(expected) || expected <= 0) {
    return NextResponse.json({ error: "Refresh the page and try again — the amount to settle was not sent." }, { status: 400 });
  }
  let preview;
  try {
    preview = await settleShortPreview(supabase as never, params.id);
  } catch (e) {
    return readFailed(e);
  }
  /* No open part with a difference → the RPC says why in its own words. */
  if (preview && preview.amount !== Math.round(expected)) {
    return NextResponse.json({
      error: `The difference on this part is now ₹${preview.amount.toLocaleString("en-IN")}, not ₹${Math.round(expected).toLocaleString("en-IN")} — refresh the page before settling.`,
    }, { status: 409 });
  }

  /* Untyped until the generated types know settle_quote_part_short (migration 20261108092350). */
  const { data, error } = await (supabase as unknown as SupabaseClient).rpc("settle_quote_part_short", {
    p_quote_id: params.id, p_reason: settleShortReason(body),
  });
  if (error) {
    const r = settleShortRefusal(error as { code?: string; message?: string });
    if (r.status === 500) console.error("[settle-short] settle_quote_part_short failed", error);
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json(data);
}
