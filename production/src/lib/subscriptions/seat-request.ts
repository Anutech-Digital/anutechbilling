/**
 * Customer-raised seat changes: what a rep is allowed to approve, and what it costs.
 *
 * ─── THE PRICE IS COMPUTED AT APPROVAL, NOT AT REQUEST ──────────────────────
 * A seat change is priced pro-rata to the renewal date, so the amount falls every day
 * the request sits in a queue. Quoting at submission and billing at approval would
 * show the customer one figure and charge another. `previewCharge` exists so both
 * sides can SEE the number for a given day; nothing stores it.
 *
 * ─── THE SUBSCRIPTION MOVES UNDERNEATH PENDING REQUESTS ─────────────────────
 * A customer asks for +20 from 10. A week later a rep has already added 30 by hand.
 * Approving the request now would take the subscription to 30 (the requested total)
 * — silently REMOVING 10 seats somebody is using, from a screen that says "approve".
 * `assessRequest` refuses that case rather than guessing which number was meant, and
 * this is the reason `current_seats` is stored on the request at all.
 *
 * ─── REDUCTIONS ARE NOT APPROVALS ───────────────────────────────────────────
 * addSeats() only adds. A request to go DOWN cannot be actioned by the same path —
 * mid-term seat reductions need a credit note and, on Microsoft NCE, are not
 * permitted at all. Those are routed to a human with the reason stated instead of
 * being approved into a code path that would silently do nothing.
 */
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";

export type SeatRequestStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface SeatRequestFacts {
  status: SeatRequestStatus;
  /** Seats on the subscription when the request was raised. */
  currentSeats: number;
  requestedSeats: number;
  /** Seats on the subscription RIGHT NOW. */
  liveSeats: number;
  /** Subscription status right now. */
  subscriptionStatus: "active" | "paused" | "expired" | "cancelled";
  renewalDate: string | null;
  /**
   * R-801: EXCLUSIVE term end (seatTermEnd) — renewal_date is the inclusive last covered day on
   * newer rows, so the renewal day itself is still inside the term. Absent = renewalDate.
   */
  termEnd?: string | null;
  /** Today, YYYY-MM-DD (IST) — pass localDateISO(new Date()). */
  today: string;
}

export type SeatRequestVerdict =
  | { canApprove: true; seatsToAdd: number; newTotal: number }
  | { canApprove: false; reason: string; nextStep: string };

/**
 * May this request be approved right now?
 *
 * Every refusal names what happened and what to do instead (§24) — a rep looking at
 * a greyed-out Approve button with no explanation will either ignore the request or
 * do it by hand and forget to close it.
 */
export function assessRequest(f: SeatRequestFacts): SeatRequestVerdict {
  if (f.status !== "pending") {
    return {
      canApprove: false,
      reason: `This request is already ${f.status}.`,
      nextStep: "Nothing to do. Open the subscription if you need to change seats again.",
    };
  }

  if (f.subscriptionStatus !== "active") {
    return {
      canApprove: false,
      reason: `The subscription is ${f.subscriptionStatus}, so seats cannot be added to it.`,
      nextStep: f.subscriptionStatus === "paused"
        ? "Settle what is outstanding and reactivate it first."
        : "Renew or recreate the subscription, then raise the seats.",
    };
  }

  const delta = f.requestedSeats - f.currentSeats;
  if (delta < 0) {
    return {
      canApprove: false,
      reason: `This is a reduction — ${f.currentSeats} seats down to ${f.requestedSeats}.`,
      nextStep: "Mid-term reductions need a credit note, and Microsoft NCE does not allow them at all. Call the customer and handle it by hand.",
    };
  }
  if (delta === 0) {
    return { canApprove: false, reason: "The request asks for the seats it already has.", nextStep: "Reject it with a note." };
  }

  /* The subscription has moved since the request. Refuse rather than guess: applying
     the requested TOTAL would remove seats somebody is using. */
  if (f.liveSeats !== f.currentSeats) {
    return {
      canApprove: false,
      reason: `This asked for ${f.requestedSeats} seats when the subscription had ${f.currentSeats}. It now has ${f.liveSeats}.`,
      nextStep: f.liveSeats >= f.requestedSeats
        ? "The seats are already there. Reject it with a note so the customer knows it is done."
        : `Approving would set the total from the old figure. Add ${f.requestedSeats - f.liveSeats} seats by hand, or ask the customer to re-raise it.`,
    };
  }

  if (!f.renewalDate) {
    return {
      canApprove: false,
      reason: "The subscription has no renewal date, so the pro-rata charge cannot be worked out.",
      nextStep: "Set the renewal date on the subscription, then approve.",
    };
  }
  if ((f.termEnd ?? f.renewalDate) <= f.today) {
    return {
      canApprove: false,
      reason: "The term has already ended.",
      nextStep: "Renew the subscription first — added seats would have no term to be pro-rated across.",
    };
  }

  return { canApprove: true, seatsToAdd: delta, newTotal: f.requestedSeats };
}

export interface ChargePreview {
  seatsToAdd: number;
  remainingDays: number;
  termDays: number;
  exGst: number;
  tax: number;
  total: number;
  /** ₹/month the subscription will bill AFTER the change. */
  newMrr: number;
}

/**
 * What the change costs if approved today.
 *
 * Goes through the shared `prorate()` — one expression, one rounding, integer paise —
 * rather than a second proration. `annualPerSeat` is derived from the CURRENT mrr and
 * seat count so the added seats are priced at what this customer actually pays, not
 * at list.
 */
export function previewCharge(args: {
  currentSeats: number;
  currentMrr: number;
  seatsToAdd: number;
  remainingDays: number;
  termDays: number;
  taxRatePct: number;
}): ChargePreview | null {
  const { currentSeats, currentMrr, seatsToAdd, remainingDays, termDays, taxRatePct } = args;
  if (seatsToAdd < 1 || currentSeats < 1 || termDays <= 0) return null;

  const perSeatMonth = currentMrr / currentSeats;
  const annualPerSeatPaise = Math.round(rupeesToPaise(perSeatMonth) * 12);

  const r = prorate({
    annualPerSeatPaise,
    seats: seatsToAdd,
    remainingDays,
    termDays,
    taxRatePct,
  });

  return {
    seatsToAdd,
    remainingDays: r.chargedDays,
    termDays,
    exGst: paiseToRupees(r.subtotalPaise),
    tax:   paiseToRupees(r.taxPaise),
    total: paiseToRupees(r.totalPaise),
    newMrr: Math.round(perSeatMonth * (currentSeats + seatsToAdd)),
  };
}

/** Badge for a request row. */
export function requestBadge(status: SeatRequestStatus): { label: string; kind: "warning" | "success" | "danger" | "muted" } {
  switch (status) {
    case "pending":   return { label: "Waiting on you", kind: "warning" };
    case "approved":  return { label: "Approved", kind: "success" };
    case "rejected":  return { label: "Rejected", kind: "danger" };
    case "withdrawn": return { label: "Withdrawn", kind: "muted" };
  }
}
