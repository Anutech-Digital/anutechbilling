/**
 * What ONE badge should a quote row show, and what cash note goes with it.
 *
 * ─── WHY THIS MOVED OUT OF THE PAGE ─────────────────────────────────────────
 * These two functions decide what an operator BELIEVES about money at a glance, and that
 * makes them money logic, not presentation. They lived inside quotes/page.tsx where
 * nothing could test them, and they were wrong in a way nobody could see:
 *
 *   Q-ADPL-2026-27-0024 · ₹38,232 · ₹20,000 received · ₹18,232 outstanding
 *   showed the badge "Out for review".
 *
 * The payment checks sat INSIDE `if (status === "accepted")`, so a quote that was still
 * at status `sent` when the first instalment arrived fell through to the status switch.
 * "Out for review" reads as "nothing has happened yet" — the exact opposite of ₹20,000 in
 * the bank. Reported by the owner as "show the partly-paid ones noticeably", which is the
 * polite version of "this row is lying to me".
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * Money outranks workflow. What has been PAID is checked before what the quote's status
 * says, because a status is a note about a conversation and a payment is a fact about a
 * bank account. A quote can be `sent` and part-paid, or `draft` and part-paid (the
 * direct-invoice path does that); in every one of those the payment is the thing the
 * reader needs first.
 */
import type { Quote } from "@/lib/supabase/database.types";

export type QuoteBadgeKind = "muted" | "success" | "warning" | "danger" | "info";

type QuoteStatusFields = Pick<Quote, "status" | "payment_status" | "amount" | "payment_amount"> & {
  /** R-448: set when a revision replaced this quote. Optional so older callers still fit. */
  superseded_by?: string | null;
};

/** What is still owed on this quote. Never negative — an overpayment is not a debt. */
export function outstanding(q: Pick<Quote, "amount" | "payment_amount">): number {
  return Math.max(0, (q.amount ?? 0) - (q.payment_amount ?? 0));
}

/**
 * ONE primary status per row (Stripe/Linear style) — quote.status and payment_status
 * folded into a single lifecycle stage, so a row never shows two competing badges.
 */
export function unifiedStatus(q: QuoteStatusFields): { label: string; kind: QuoteBadgeKind } {
  /* Payment first, and independent of `status`. This ordering IS the fix: every one of
     these was previously reachable only from `status === "accepted"`. */
  if (q.payment_status === "invoiced") return { label: "Invoiced", kind: "info" };
  if (q.payment_status === "partial") {
    /* Rose, not amber. Amber is the same tone this list gives "Out for review" and
       "expiring soon" — ordinary busywork. A part-paid quote is money sitting half
       collected, and it should not look like a reminder to send an email. */
    return { label: "Partly paid", kind: "danger" };
  }
  if (q.payment_status === "received") return { label: "Paid", kind: "success" };

  if (q.status === "accepted") return { label: "Accepted", kind: "success" };

  switch (q.status) {
    case "draft":    return { label: "Draft", kind: "muted" };
    case "sent":     return { label: "Out for review", kind: "warning" };
    case "viewed":   return { label: "Viewed", kind: "info" };
    case "rejected": return { label: "Rejected", kind: "danger" };
    case "expired":  return q.superseded_by ? { label: "Replaced", kind: "muted" } : { label: "Expired", kind: "danger" };
    default:         return { label: "Draft", kind: "muted" };
  }
}

export interface QuoteCashNote {
  text: string;
  /** `owed` = real money outstanding (render in rose). `waiting` = nothing received yet. */
  tone: "owed" | "waiting";
}

/**
 * The cash line that rides with the badge.
 *
 * For a part-paid quote it carries BOTH halves — what came in and what is left — because
 * either number alone invites the wrong conclusion: "₹18,232 due" hides that most of it
 * is collected, and "₹20,000 paid" hides that it is not finished.
 */
export function cashNote(q: QuoteStatusFields): QuoteCashNote | null {
  const due = outstanding(q);
  const paid = q.payment_amount ?? 0;
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  if (q.payment_status === "partial" && due > 0) {
    return { text: `${inr(paid)} paid · ${inr(due)} left`, tone: "owed" };
  }
  if (q.payment_status === "invoiced" && due > 0) {
    return { text: `${inr(due)} due`, tone: "owed" };
  }
  if (
    q.payment_status === "awaiting" ||
    (q.status === "accepted" && (!q.payment_status || q.payment_status === "none"))
  ) {
    return { text: "Awaiting payment", tone: "waiting" };
  }
  return null;
}
