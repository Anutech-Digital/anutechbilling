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
import { quoteBalanceDue } from "./list-tab";
import { invoicedPartPaid } from "./quote-payment-state";
import { shownQuoteStatus } from "./quote-expiry";
import { istToday } from "@/lib/dates/ist";
import { QUOTE_STATE_LABEL } from "./state-labels";
import { isCustomerAdvanceQuote, CUSTOMER_ADVANCE_LABEL } from "./customer-advance";
import { paidToDateOf, PAID_TO_DATE_LABEL } from "./paid-to-date";

export type QuoteBadgeKind = "muted" | "success" | "warning" | "danger" | "info";

type QuoteStatusFields = Pick<Quote, "status" | "payment_status" | "amount" | "payment_amount"> & {
  /** R-448: set when a revision replaced this quote. Optional so older callers still fit. */
  superseded_by?: string | null;
  /** R-1707: quote_open_balance() (lib/quotes/open-balances.ts). null/absent = not loaded. */
  open_balance?: number | null;
  /** R-1679: the validity date — a sent / viewed quote past it reads "Expired" (quote-expiry.ts). */
  expires_date?: string | null;
  invoice_id?: string | null;
  /** R-2023: an R-1863 advance holder ("Advance on account", ₹0, no lines) is not a sale. */
  plan?: string | null;
  line_items?: unknown;
  /** R-2055: the plan fields (paid-to-date.ts) — optional so older callers still fit. */
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
  billing_cycle?: string | null;
  subscription_billing_id?: string | null;
};

/** What is still owed on this quote. Never negative — an overpayment is not a debt. */
export function outstanding(q: Pick<Quote, "amount" | "payment_amount">): number {
  return Math.max(0, (q.amount ?? 0) - (q.payment_amount ?? 0));
}

/**
 * ONE primary status per row (Stripe/Linear style) — quote.status and payment_status
 * folded into a single lifecycle stage, so a row never shows two competing badges.
 */
export function unifiedStatus(q: QuoteStatusFields, today: string = istToday()): { label: string; kind: QuoteBadgeKind } {
  /* R-2023: a customer's advance (R-1863 holder quote) is money kept as credit — never "Paid"
     or "Accepted" like a sale (customer-advance.ts). */
  if (isCustomerAdvanceQuote(q) && q.status !== "rejected") return { label: CUSTOMER_ADVANCE_LABEL, kind: "info" };
  /* Payment first, and independent of `status`. This ordering IS the fix: every one of
     these was previously reachable only from `status === "accepted"`. */
  if (q.payment_status === "invoiced") {
    /* R-1710: the stage alone hid a half payment — say both (money from quote-payment-state.ts). */
    return invoicedPartPaid(q) ? { label: `${QUOTE_STATE_LABEL.invoiced} · ${QUOTE_STATE_LABEL.partial}`, kind: "danger" } : { label: QUOTE_STATE_LABEL.invoiced, kind: "info" };
  }
  /* R-2055: billed in parts, first part paid — nothing is owed on this quote today. */
  if (q.payment_status === "partial" && paidToDateOf(q)) return { label: PAID_TO_DATE_LABEL, kind: "success" };
  if (q.payment_status === "partial") {
    /* Rose, not amber. Amber is the same tone this list gives "Out for review" and
       "expiring soon" — ordinary busywork. A part-paid quote is money sitting half
       collected, and it should not look like a reminder to send an email. */
    return { label: QUOTE_STATE_LABEL.partial, kind: "danger" };
  }
  if (q.payment_status === "received") return { label: QUOTE_STATE_LABEL.received, kind: "success" };

  if (q.status === "accepted") return { label: QUOTE_STATE_LABEL.accepted, kind: "success" };

  /* R-1679: a sent / viewed quote past its validity date is Expired — staff saw "Sent" on
     Q-5F40-27-0096 a day after "Valid until 18 Oct" while the customer's accept was refused. */
  switch (shownQuoteStatus(q, today)) {
    case "draft":    return { label: QUOTE_STATE_LABEL.draft, kind: "muted" };
    /* R-1713: "Sent" — the tab's word. "Out for review" was a third name for the same state. */
    case "sent":     return { label: QUOTE_STATE_LABEL.sent, kind: "warning" };
    case "viewed":   return { label: QUOTE_STATE_LABEL.viewed, kind: "info" };
    case "rejected": return { label: QUOTE_STATE_LABEL.rejected, kind: "danger" };
    case "expired":  return q.superseded_by ? { label: QUOTE_STATE_LABEL.replaced, kind: "muted" } : { label: QUOTE_STATE_LABEL.expired, kind: "danger" };
    default:         return { label: QUOTE_STATE_LABEL.draft, kind: "muted" };
  }
}

/**
 * R-1718: a quote that is CLOSED — rejected, expired or replaced by a revision — is not waiting
 * for money. Rejecting leaves payment_status at "awaiting" (Q-F588-27-0031 showed "Rejected"
 * and "Awaiting payment" side by side), so the payment status is read through this rule.
 */
export function isClosedQuote(
  q: Pick<QuoteStatusFields, "status" | "superseded_by" | "expires_date" | "payment_status" | "invoice_id">,
  today: string = istToday(),
): boolean {
  /* R-1679: validity ended (sent / viewed, nothing paid) counts as expired — one rule, quote-expiry.ts. */
  return q.status === "rejected" || shownQuoteStatus(q, today) === "expired" || !!q.superseded_by;
}

/**
 * R-1718: the payment status to show beside the quote's status, or null for none. The ONE rule
 * for the detail header badge and the list's cash note. "none" is never shown; "awaiting" is
 * not shown on a closed quote. Money that really came in (partial / received / invoiced) is a
 * fact and stays visible whatever the status says.
 */
export function quotePaymentBadge(
  q: Pick<QuoteStatusFields, "status" | "payment_status" | "superseded_by">,
): Exclude<Quote["payment_status"], "none"> | null {
  const ps = q.payment_status;
  if (!ps || ps === "none") return null;
  if (ps === "awaiting" && isClosedQuote(q)) return null;
  return ps;
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
  /* R-1707: the same balance the list tab uses (credit notes and refunds counted). */
  const due = quoteBalanceDue(q);
  const paid = q.payment_amount ?? 0;
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  /* R-2023: an advance's amount is ₹0 (nothing sold) — the money is its receipt. */
  if (isCustomerAdvanceQuote(q) && q.status !== "rejected") {
    return (q.payment_amount ?? 0) > 0 ? { text: `${inr(q.payment_amount ?? 0)} advance`, tone: "waiting" } : null;
  }

  /* R-1710: invoiced after a part payment — the same two halves as before the invoice. */
  /* R-2055: the later parts are payment requests (R-2044) — committed, not "left" on this quote. */
  if (q.payment_status === "partial" && paidToDateOf(q)) {
    return { text: `${inr(paid)} paid to date`, tone: "waiting" };
  }
  if ((q.payment_status === "partial" || invoicedPartPaid(q)) && due > 0) {
    return { text: `${inr(paid)} paid · ${inr(due)} left`, tone: "owed" };
  }
  if (q.payment_status === "invoiced" && due > 0) {
    return { text: `${inr(due)} due`, tone: "owed" };
  }
  if (
    quotePaymentBadge(q) === "awaiting" ||
    (q.status === "accepted" && !q.superseded_by && (!q.payment_status || q.payment_status === "none"))
  ) {
    return { text: QUOTE_STATE_LABEL.awaiting, tone: "waiting" };
  }
  return null;
}
