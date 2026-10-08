/**
 * POST /api/seat-requests/[id]/decide
 *
 * A rep approving or rejecting a customer's seat request.
 *
 * ─── APPROVING *IS* APPLYING ────────────────────────────────────────────────
 * There is no "approved but not yet done" state. Approval runs the same
 * applySeatIncrease() path the operator's Add Seats dialog uses — the subscription's
 * seats go up, the pro-rata quote is raised, and the quote id is written back onto
 * the request. A status that meant "we said yes but nothing happened" is exactly the
 * ambiguity this table replaced tickets to remove.
 *
 * ─── THE GUARDS RUN SERVER-SIDE, NOT ONLY IN THE UI ─────────────────────────
 * assessRequest() decides whether this request can be approved at all: the
 * subscription may have moved since it was raised, it may have been paused, the term
 * may have ended, or it may be a reduction (which addSeats cannot do). The queue
 * shows the same verdict, but a disabled button is not a guard — this is.
 *
 * ─── THE STATUS IS WRITTEN ONLY AFTER THE SEATS ARE ADDED ───────────────────
 * If addSeats fails, the request stays `pending`. Marking it approved first and
 * adding seats second would, on any failure, leave a request that says "done" over a
 * subscription nobody changed — and the customer would be told their seats were
 * ready.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClientFor } from "@/lib/supabase/server";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { withRoute, dbFail } from "@/lib/api/with-route";
import { applySeatIncrease, SEAT_INCREASE_SELECT } from "@/lib/subscriptions/apply-seat-increase";
import { assessRequest } from "@/lib/subscriptions/seat-request";
import { localDateISO } from "@/lib/leads/outcomes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DECISION_MSG = "decision must be 'approved' or 'rejected'";
const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"], { message: DECISION_MSG }),
  note: z.string().trim().max(1000).optional(),
});

/* R-217 (R-051): withRoute() does sign-in, tenant, the role gate (ACTION_ROLES
   "seats.change" = owner/manager/billing) and the zod body in one place. */
export const POST = withRoute(
  {
    route: "api/seat-requests/decide",
    input: bodySchema,
    roles: ACTION_ROLES["seats.change"],
    roleHint: forbiddenMessage("seats.change"),
  },
  async ({ input, params, user, tenantId }) => {
  const supabase = createAdminClientFor(user.id); // R-051: audit log names the caller

  const { data: request, error: reqErr } = await supabase
    .from("seat_requests").select("*").eq("id", params.id).single();
  if (reqErr || !request) return NextResponse.json({ error: "request not found" }, { status: 404 });
  if (request.tenant_id !== tenantId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (request.status !== "pending") {
    return NextResponse.json({ error: `This request is already ${request.status}.` }, { status: 409 });
  }

  // ── Rejection: a status change and a note the customer will read. ─────────
  if (input.decision === "rejected") {
    const { error } = await supabase
      .from("seat_requests")
      .update({
        status: "rejected",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        decision_note: input.note ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.id);
    dbFail(error, "Faisla save nahi hua — thodi der baad dobara try kariye.");
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // ── Approval ──────────────────────────────────────────────────────────────
  const { data: sub, error: subErr } = await supabase
    .from("subscriptions").select(SEAT_INCREASE_SELECT).eq("id", request.subscription_id).single();
  if (subErr || !sub) return NextResponse.json({ error: "subscription not found" }, { status: 404 });

  /* The same verdict the queue shows, enforced here. A disabled button is not a
     guard — this request could have been approved from a stale tab. */
  const verdict = assessRequest({
    status: request.status,
    currentSeats: request.current_seats,
    requestedSeats: request.requested_seats,
    liveSeats: sub.seats,
    subscriptionStatus: sub.status as "active" | "paused" | "expired" | "cancelled",
    renewalDate: sub.renewal_date,
    today: localDateISO(new Date()),
  });

  if (!verdict.canApprove) {
    /* 409, not 400: nothing about the request is malformed — the world moved. The
       reason and the next step both go back so the UI can show them verbatim. */
    return NextResponse.json({ error: verdict.reason, nextStep: verdict.nextStep }, { status: 409 });
  }

  const { data: tenant } = await supabase
    .from("tenants").select("grace_period_days").eq("id", sub.tenant_id).single();

  const result = await applySeatIncrease({
    supabase,
    sub,
    additionalSeats: verdict.seatsToAdd,
    graceDays: tenant?.grace_period_days ?? 7,
  });

  if (!result.ok) {
    /* The request stays pending. It can be retried once whatever failed is fixed,
       and it does not sit there claiming to be done. */
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }

  const { error: markErr } = await supabase
    .from("seat_requests")
    .update({
      status: "approved",
      quote_id: result.quoteId,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decision_note: input.note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (markErr) {
    /* The seats ARE added and the quote IS raised — that cannot be undone here, and
       pretending otherwise would be worse. Report the real state so a human closes
       the request rather than approving it twice. */
    console.error(`[seat-requests] seats added (quote ${result.quoteId}) but request ${params.id} not marked:`, markErr);
    return NextResponse.json({
      ok: true,
      status: "approved",
      quoteId: result.quoteId,
      warning: `The seats were added and quote ${result.quoteId} was raised, but this request could not be marked approved. Close it by hand — do not approve it again.`,
    });
  }

  return NextResponse.json({
    ok: true,
    status: "approved",
    quoteId: result.quoteId,
    amount: result.amount,
    newSeats: result.newSeats,
    newMrr: result.newMrr,
    proRataDays: result.proRataDays,
  });
  },
);
