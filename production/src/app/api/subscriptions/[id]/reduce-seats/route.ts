/**
 * R-2252 (Zoho Billing audit A17) — Reduce seats, with the credit shown before saving.
 *
 * GET  /api/subscriptions/[id]/reduce-seats?seats=N
 *   The preview: unused value of N seats for the rest of the current part (Add seats' pricing),
 *   the part's tax invoice, R-2255's split (lowers what they owe / credit from money received /
 *   not given), whether "Now" can be saved and why not, the NCE lock, a cut already scheduled.
 * POST /api/subscriptions/[id]/reduce-seats
 *   Body: { seats_removed: 1..4999, timing: "now" | "end_of_term", idempotency_key: 8..128 }
 *   Books it through reduce_subscription_seats() — one transaction: credit note on the part's
 *   invoice for the split, seats + mrr lowered, the subscription's balance re-synced; or, at end
 *   of term, a scheduled row only. The unused value is worked out HERE with the same pricing as the
 *   preview (never taken from the browser); the function bounds it and repeats the split on the
 *   locked invoice row.
 * DELETE /api/subscriptions/[id]/reduce-seats
 *   Takes back a cut scheduled for the end of the term (cancel_scheduled_seat_reduction).
 *
 * Who: seats.change (owner / manager / billing — all of them may also issue a credit note).
 * Microsoft NCE: "Now" is refused after the 7-day window (checkNceLock); end of term would be
 * allowed — but R-2584: "end_of_term" is refused while SEAT_CUT_END_OF_TERM_ENABLED is off (renewal
 * does not apply a scheduled cut yet — R-2583), so an NCE-locked subscription has no seat cut in
 * the app until then. A cut scheduled before R-2584 can still be removed (DELETE).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";
import { resolveSeatTax } from "@/lib/subscriptions/apply-seat-increase";
import { seatReductionValue, seatReductionPreview, SEAT_CUT_END_OF_TERM_ENABLED } from "@/lib/subscriptions/seat-reduction";
import { checkNceLock } from "@/lib/subscriptions/nce-lock";
import { istToday } from "@/lib/dates/ist";
import { REDUCE_SEATS_SELECT, loadPartInvoiceMoney, loadScheduledReduction, type ReduceSeatsSub } from "./load";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  seats_removed: z.coerce.number().int().min(1).max(4999),
  timing: z.enum(["now", "end_of_term"]),
  idempotency_key: z.string().trim().min(8, "idempotency_key must be at least 8 characters").max(128),
});

/** check_violation, invalid_parameter_value, no_data_found, insufficient_privilege — raised with plain words. */
const PLAIN_REFUSALS = new Set(["23514", "22023", "P0002", "42501"]);

type Gate =
  | { ok: true; userId: string; supabase: ReturnType<typeof createAdminClientFor>; sub: ReduceSeatsSub }
  | { ok: false; res: NextResponse };

async function gate(id: string): Promise<Gate> {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const { data: me } = await userClient.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return { ok: false, res: NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 }) };
  if (!mayDo((me as { role?: string | null }).role, "seats.change")) {
    return { ok: false, res: NextResponse.json({ error: forbiddenMessage("seats.change") }, { status: 403 }) };
  }
  const supabase = createAdminClientFor(authData.user.id); // R-051: audit log names the caller
  const { data: sub } = await supabase.from("subscriptions").select(REDUCE_SEATS_SELECT).eq("id", id).maybeSingle();
  const row = sub as ReduceSeatsSub | null;
  /* Another company's id looks exactly like a missing one. */
  if (!row || row.tenant_id !== me.tenant_id) {
    return { ok: false, res: NextResponse.json({ error: "subscription not found" }, { status: 404 }) };
  }
  if (row.status !== "active") {
    return { ok: false, res: NextResponse.json({ error: `Seats can only be reduced on an active subscription (this one is ${row.status}).` }, { status: 400 }) };
  }
  return { ok: true, userId: authData.user.id, supabase, sub: row };
}

/** Everything the dialog shows, and what POST books — one function so they cannot differ. */
async function buildPreview(g: Extract<Gate, { ok: true }>, seatsRemoved: number) {
  const today = istToday();
  const { sub, supabase } = g;
  const [{ taxRatePct, taxLabel }, scheduled, invoice] = await Promise.all([
    resolveSeatTax(supabase, sub.customer_id, sub.tenant_id),
    loadScheduledReduction(supabase, sub, today),
    loadPartInvoiceMoney(supabase, sub, today),
  ]);
  const value = seatReductionValue({ sub, seatsRemoved, today, taxRatePct });
  const nce = checkNceLock({
    vendor: sub.vendor, startDate: sub.start_date, today, currentSeats: sub.seats,
    nextSeats: sub.seats - seatsRemoved, nextStatus: sub.status,
  });
  if (!value.ok) return { today, taxLabel, value, preview: null, nce, scheduled };
  return { today, taxLabel, value, preview: seatReductionPreview(value, invoice), nce, scheduled };
}

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const g = await gate(id);
  if (!g.ok) return g.res;
  const seats = Number(new URL(req.url).searchParams.get("seats") ?? "1");
  const p = await buildPreview(g, Number.isFinite(seats) ? Math.trunc(seats) : 0);
  return NextResponse.json({
    seats: g.sub.seats,
    renewalDate: g.sub.renewal_date,
    taxLabel: p.taxLabel,
    value: p.value,
    preview: p.preview,
    nceLocked: p.nce.locked,
    nceReason: p.nce.reason,
    scheduled: p.scheduled,
  });
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }
  const g = await gate(id);
  if (!g.ok) return g.res;
  const { seats_removed: seatsRemoved, timing, idempotency_key: key } = parsed.data;
  /* R-2584: renewal does not apply a scheduled cut yet (R-2583) — the renewal would still bill the old seats. */
  if (timing === "end_of_term" && !SEAT_CUT_END_OF_TERM_ENABLED) {
    return NextResponse.json({ error: "Reducing seats at the end of the term is not available yet — reduce them now, with credit.", code: "end_of_term_off" }, { status: 400 });
  }

  const p = await buildPreview(g, seatsRemoved);
  if (!p.value.ok) {
    /* An end-of-term cut needs no unused days — only a valid seat count. */
    if (timing === "now" || p.value.code === "invalid_seats" || p.value.code === "too_many") {
      return NextResponse.json({ error: p.value.message, code: p.value.code }, { status: 400 });
    }
  }
  if (timing === "now") {
    if (g.sub.written_off_at) {
      return NextResponse.json({ error: "This subscription's dues are written off — a seat cut with credit would contradict the write-off. Use Correct details instead.", code: "written_off" }, { status: 409 });
    }
    if (p.nce.locked) return NextResponse.json({ error: p.nce.reason, code: "nce_locked" }, { status: 409 });
    if (p.preview && !p.preview.canReduceNow) {
      return NextResponse.json({ error: p.preview.blockedReason, code: "no_invoice" }, { status: 409 });
    }
  }

  const unusedGross = timing === "now" && p.value.ok ? p.value.total : 0;
  const newMrr = timing === "now" && p.value.ok ? p.value.newMrr : 0;
  const { data, error } = await g.supabase.rpc("reduce_subscription_seats" as never, {
    p_tenant_id: g.sub.tenant_id,
    p_subscription_id: g.sub.id,
    p_seats_removed: seatsRemoved,
    p_timing: timing,
    p_unused_gross: unusedGross,
    p_new_mrr: newMrr,
    p_idempotency_key: key,
    p_actor: g.userId,
    p_seats_before: g.sub.seats,
  } as never);
  if (error) {
    const code = (error as { code?: string }).code ?? "";
    /* A 23505 is a double click that lost the race to the first one (nothing was booked twice). */
    if (code === "23505") {
      return NextResponse.json({ error: "This seat cut is already being saved — refresh in a few seconds. Do not submit again.", code: "in_progress" }, { status: 409 });
    }
    /* The function's own refusals are written for the owner (§24); anything else stays in the log. */
    if (PLAIN_REFUSALS.has(code)) {
      return NextResponse.json({ error: error.message, code: "refused" }, { status: 400 });
    }
    console.error("[reduce-seats] reduce_subscription_seats failed:", error);
    return NextResponse.json({ error: "Seats not reduced — the server could not save this change. Nothing was changed. Try again in a minute; if it still fails, use Report a problem.", code: "failed" }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const g = await gate(id);
  if (!g.ok) return g.res;
  const { data, error } = await g.supabase.rpc("cancel_scheduled_seat_reduction" as never, {
    p_tenant_id: g.sub.tenant_id,
    p_subscription_id: g.sub.id,
  } as never);
  if (error) {
    const code = (error as { code?: string }).code ?? "";
    if (PLAIN_REFUSALS.has(code)) return NextResponse.json({ error: error.message, code: "refused" }, { status: 400 });
    console.error("[reduce-seats] cancel_scheduled_seat_reduction failed:", error);
    return NextResponse.json({ error: "The scheduled cut was not removed — try again in a minute; if it still fails, use Report a problem.", code: "failed" }, { status: 500 });
  }
  return NextResponse.json(data);
}
