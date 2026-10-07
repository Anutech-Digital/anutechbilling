/**
 * POST /api/subscriptions/[id]/add-seats
 *
 * Mid-term seat expansion. Operator-triggered when customer requests
 * additional seats while the current subscription term is active.
 *
 * Behaviour:
 *   1. Pro-rata calculation: annual_rate × additional_seats × (days_remaining / 365)
 *   2. subscription.seats incremented immediately + mrr recomputed
 *   3. Quote created for the pro-rata billing (sent, awaiting payment)
 *
 * Body: { additional_seats: 1..5000, idempotency_key: string }
 * Returns: { quoteId, amount, proRataDays, newSeats, newMrr }
 *
 * ─── R-060: THE IDEMPOTENCY KEY IS REQUIRED ─────────────────────────────────
 * Until R-060 the only thing stopping a double submit was `disabled={submitting}` on
 * the dialog's button. A second POST — a double-click that beat the state update, a
 * browser retry on a slow response, a second tab, curl — ran all four writes again:
 * the seats went up TWICE and the customer got TWO pro-rata quotes for one expansion.
 * A disabled button is not a guard; the same sentence is already written into
 * seat-requests/[id]/decide.
 *
 * The key is required rather than optional because a key callers may omit protects
 * only the callers who remember. There is exactly one caller (add-seats-dialog.tsx),
 * so nothing is broken by requiring it — and a request that arrives without one is,
 * by definition, from something that was never taught the rule.
 *
 * The claim is inserted BEFORE the work and the unique index does the deciding; see
 * supabase/migrations/20260930177000_seat_increase_claims.sql for why this shape and
 * not a lock, and for why a failed attempt releases its key.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";
import { applySeatIncrease, SEAT_INCREASE_SELECT } from "@/lib/subscriptions/apply-seat-increase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  additional_seats: z.coerce.number().int().min(1).max(5000),
  /* Opaque — the server never parses it. Min 8 so a caller cannot defeat the point
     with "1"; max 128 so it cannot be used as a jsonb smuggling channel. */
  idempotency_key: z.string().trim().min(8, "idempotency_key must be at least 8 characters").max(128),
});

/**
 * Postgres unique_violation. The whole mechanism is this code arriving from the claim
 * insert: someone else already claimed this key, so this request is a replay.
 */
const UNIQUE_VIOLATION = "23505";

/**
 * Codes from applySeatIncrease that mean NOTHING was written.
 *
 * These release the claim, because a key burned by an attempt that did not happen
 * leaves the operator unable to retry the thing that did not happen. `sub_update_failed`
 * is deliberately absent: there the quote WAS inserted and only the seat update failed,
 * so the claim is kept as `failed` and a replay reports the half-done state instead of
 * raising a second quote on top of the first.
 */
const WROTE_NOTHING = new Set(["invalid_seats", "no_renewal_date", "term_ended", "no_doc_number", "insert_failed"]);

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await userClient
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }
  /* S19: signed in + same tenant is not enough for this one. */
  if (!mayDo((me as { role?: string | null }).role, "seats.change")) {
    return NextResponse.json({ error: forbiddenMessage("seats.change") }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const supabase = createAdminClientFor(authData.user.id); // R-051: audit log names the caller
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    // Shared column list, so both seat-adding routes select the same set. start_date
    // is in it because without it the term length is unknowable and add-seats fell
    // back to assuming a year for every subscription.
    .select(SEAT_INCREASE_SELECT)
    .eq("id", params.id)
    .single();
  if (subErr || !sub) {
    return NextResponse.json({ error: "subscription not found" }, { status: 404 });
  }
  if (sub.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: `cannot add seats — subscription is ${sub.status}` },
      { status: 400 }
    );
  }
  if (!sub.renewal_date) {
    return NextResponse.json({ error: "subscription has no renewal_date" }, { status: 400 });
  }

  /* ── R-060: claim the key BEFORE any money moves ────────────────────────────
     Everything above this line is validation — a 400/403/404 must not burn a key, or
     the operator fixes the problem and finds their retry rejected as a duplicate. */
  const idempotencyKey = parsed.data.idempotency_key;
  const { data: claim, error: claimErr } = await supabase
    .from("seat_increase_claims")
    .insert({
      tenant_id:        sub.tenant_id,
      subscription_id:  sub.id,
      idempotency_key:  idempotencyKey,
      requested_by:     authData.user.id,
      additional_seats: parsed.data.additional_seats,
      status:           "in_progress",
    })
    .select("id")
    .single();

  if (claimErr) {
    if (claimErr.code !== UNIQUE_VIOLATION) {
      /* The claim could not be written, so idempotency cannot be guaranteed. Refuse
         rather than proceed — the same call the compliance-reminders cron makes when
         its log is unreadable. Doing the work anyway is how you get the double add
         this whole mechanism exists to prevent. */
      console.error("[add-seats] claim insert failed:", claimErr);
      return NextResponse.json({
        error: "Could not start this seat change safely — try again in a moment. If it keeps failing, tell your admin the seat_increase_claims table is unreachable.",
        code:  "claim_failed",
      }, { status: 503 });
    }

    // ── A replay. Answer with what the first attempt did. ────────────────────
    const { data: prior } = await supabase
      .from("seat_increase_claims")
      .select("status, result, error_code, error_message")
      .eq("tenant_id", sub.tenant_id)
      .eq("idempotency_key", idempotencyKey)
      .single();

    if (prior?.status === "done" && prior.result) {
      /* 200 with the ORIGINAL body. The caller asked for one seat increase and got one;
         from its point of view nothing failed, and `replayed` lets the UI say so rather
         than claiming a second expansion happened. */
      return NextResponse.json({ ...(prior.result as Record<string, unknown>), replayed: true });
    }
    if (prior?.status === "failed") {
      return NextResponse.json({
        error: prior.error_message ?? "The earlier attempt with this key did not finish.",
        code:  prior.error_code ?? "claim_failed",
        replayed: true,
      }, { status: 409 });
    }
    /* Still in flight — this is the actual double-click, arriving while the first
       request is mid-write. §24: say what to do, which is nothing. */
    return NextResponse.json({
      error: "These seats are already being added — give it a few seconds and refresh. Do not submit again.",
      code:  "in_progress",
    }, { status: 409 });
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("grace_period_days")
    .eq("id", sub.tenant_id)
    .single();

  /* The GST treatment and the term length are derived in ONE place —
     lib/subscriptions/apply-seat-increase.ts — because a second route now adds
     seats too (approving a customer's request). Both derivations have already been
     wrong once here: a hardcoded 1.18 billed GST on a zero-rated export, and a
     hardcoded 365 billed a two-year term as a year. Copying the fixed versions into
     the second caller is how those come back. */
  const result = await applySeatIncrease({
    supabase,
    sub,
    additionalSeats: parsed.data.additional_seats,
    graceDays: tenant?.grace_period_days ?? 7,
  });

  if (!result.ok) {
    if (WROTE_NOTHING.has(result.code)) {
      /* Release the key. Nothing happened, so the operator must be able to fix the
         cause and press the same button again. */
      await supabase.from("seat_increase_claims").delete().eq("id", claim.id);
    } else {
      /* sub_update_failed: the quote exists and the seats do not. Keep the claim so a
         replay reports THIS, rather than raising a second quote for the same expansion.
         The identical decision is made in seat-requests/[id]/decide when the request
         cannot be marked approved — half-done has to stay visible. */
      await supabase
        .from("seat_increase_claims")
        .update({
          status:        "failed",
          error_code:    result.code,
          error_message: result.message,
          completed_at:  new Date().toISOString(),
        })
        .eq("id", claim.id);
    }
    const status = result.code === "term_ended" ? 409 : 400;
    return NextResponse.json({ error: result.message, code: result.code }, { status });
  }

  const responseBody = {
    quoteId:        result.quoteId,
    amount:         result.amount,
    proRataDays:    result.proRataDays,
    newSeats:       result.newSeats,
    newMrr:         result.newMrr,
    poId:           result.poId,
    subscriptionId: sub.id,
  };

  /* Stored, not just marked done: a replay has to be able to answer "which quote?" —
     without it the operator is left on a dialog with nothing to open, and their next
     move is to try again somewhere else. */
  const { error: doneErr } = await supabase
    .from("seat_increase_claims")
    .update({ status: "done", result: responseBody, completed_at: new Date().toISOString() })
    .eq("id", claim.id);
  if (doneErr) {
    /* The seats ARE added and the quote IS raised. Say so — a replay of this key will
       now read `in_progress` and be told to wait, which is the safe wrong answer
       (it refuses a second add) rather than the dangerous one. */
    console.error(`[add-seats] seats added (quote ${result.quoteId}) but claim ${claim.id} not marked done:`, doneErr);
  }

  return NextResponse.json(responseBody);
}
