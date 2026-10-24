/**
 * R-1726 (+R-1724): the ONE primary (orange) button on the quote page — the right next step
 * for the quote's state. Every other action on the page renders as a secondary button or sits
 * in More. Before this the page decided "primary" in five places on its own: a sent quote
 * showed three orange buttons side by side (Send on WhatsApp, Mark accepted (no payment yet),
 * Record payment), a paid invoice still had "Send on WhatsApp" as the main button, and a
 * rejected quote led with "Send on WhatsApp" — sending a closed quote again.
 *
 *   draft                       → Send on WhatsApp (the page's own send; Mark as sent beside it)
 *   sent / viewed               → Record payment          (Mark accepted is secondary)
 *   accepted, nothing paid      → Record payment          (Invoice now is secondary)
 *   part paid                   → Record balance payment
 *   paid, no invoice yet        → Generate GST Invoice
 *   invoiced, balance due       → Record payment
 *   invoiced and paid           → Send receipt            (View invoice is secondary)
 *   rejected / expired          → Duplicate
 *   replaced (superseded)       → none — the line names the quote that replaced it
 *
 * Repairs come first when they block the next step: a paid deal with no subscription
 * (Re-create subscription) and a missing GST state that stops the invoice (Fix it).
 * A role that cannot record money (sales, support) never gets a money primary — it falls back
 * to the status step (Mark accepted) or to nothing.
 */

export type QuotePrimaryAction =
  | "send_whatsapp"
  | "mark_accepted"
  | "record_payment"
  | "generate_invoice"
  | "fix_gst"
  | "send_receipt"
  | "view_invoice"
  | "duplicate"
  | "rebuild_subscription"
  | null;

export interface QuotePrimaryInput {
  /** quotes.status */
  status: string;
  /** Set when a sent revision replaced this quote (the database also marks it expired). */
  supersededBy?: string | null;
  invoiceId?: string | null;
  paymentStatus?: string | null;
  /** quoteMoneyActions(...) — what the money row offers. */
  money: { stage: string; canRecordPayment: boolean; canGenerateInvoice: boolean };
  /** ₹ still owed against the invoice (invoiced quotes) — total − received. */
  invoiceBalance: number;
  /** At least one RECEIVED payment exists (a receipt can be sent). */
  hasReceivedPayment: boolean;
  /** canRecordMoney(role) — owner / manager / accountant / billing. */
  mayRecordMoney: boolean;
  /** The GST-state block above the invoice button is showing. */
  gstBlocked: boolean;
  /** A paid deal whose subscription is missing (orphan-quote.ts). */
  orphan: boolean;
  /** Customer copies (PDF / WhatsApp / email) are locked pending approval. */
  customerCopyBlocked: boolean;
}

/** A closed quote: rejected, expired or replaced (status-badge.ts isClosedQuote). */
export function isClosedForSending(q: { status: string; supersededBy?: string | null }): boolean {
  return q.status === "rejected" || q.status === "expired" || !!q.supersededBy;
}

export function quotePrimaryAction(q: QuotePrimaryInput): QuotePrimaryAction {
  if (isClosedForSending(q)) return q.supersededBy ? null : "duplicate";
  if (q.orphan) return "rebuild_subscription";

  const invoiced = !!q.invoiceId || q.paymentStatus === "invoiced";
  if (invoiced) {
    if (q.invoiceBalance > 0) return q.mayRecordMoney ? "record_payment" : "view_invoice";
    return q.hasReceivedPayment ? "send_receipt" : "view_invoice";
  }

  if (q.status === "draft" && q.money.stage === "draft") {
    return q.customerCopyBlocked ? null : "send_whatsapp";
  }

  if (q.mayRecordMoney && q.money.canRecordPayment) return "record_payment";
  if (q.mayRecordMoney && q.money.canGenerateInvoice) return q.gstBlocked ? "fix_gst" : "generate_invoice";

  if (q.status === "sent" || q.status === "viewed") return "mark_accepted";
  /* Paid (e.g. split-billed, invoiced per period by the billing run) — the receipt is next. */
  if (q.hasReceivedPayment) return "send_receipt";
  return null;
}

/** The variant for a button that is `action`: primary only when it is THE next step. */
export function variantFor(
  primary: QuotePrimaryAction,
  action: Exclude<QuotePrimaryAction, null>,
  otherwise: "default" | "ghost" = "default",
): "primary" | "default" | "ghost" {
  return primary === action ? "primary" : otherwise;
}
