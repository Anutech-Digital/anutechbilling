/**
 * R-2326 — the quote page says "waits for the owner's approval" BEFORE the payment form, not
 * after Confirm. Both rules are reused, never restated:
 *   • the block = lib/quotes/payment-approval paymentApprovalBlock (mirrors the DB trigger
 *     tg_payments_quote_approval: below cost and not approved; its text is the server's text);
 *   • the header word = lib/quotes/status-badge unifiedStatus, the Quotes list's own rule
 *     ("Needs approval" on a live quote waiting for sign-off).
 */
import { paymentApprovalBlock, NEEDS_APPROVAL_LABEL, type PaymentApprovalFacts } from "@/lib/quotes/payment-approval";
import { unifiedStatus } from "@/lib/quotes/status-badge";
import { istToday } from "@/lib/dates/ist";

/** Would the server refuse a payment on this quote right now? `null` = record as today. */
export function recordPaymentBlock(q: PaymentApprovalFacts): { reason: string } | null {
  return paymentApprovalBlock(q);
}

/** What pressing Record payment does: the approval notice while blocked, else the form. */
export function recordPaymentStep(block: { reason: string } | null): "notice" | "form" {
  return block ? "notice" : "form";
}

type HeaderBadge = { kind: "muted" | "success" | "warning" | "danger" | "info"; label: string };

/** The header status: the list's "Needs approval" while the quote waits for sign-off, else `base`. */
export function quoteHeaderStatus(
  q: Parameters<typeof unifiedStatus>[0],
  base: HeaderBadge,
  today: string = istToday(),
): HeaderBadge {
  const listed = unifiedStatus(q, today);
  return listed.label === NEEDS_APPROVAL_LABEL ? listed : base;
}
