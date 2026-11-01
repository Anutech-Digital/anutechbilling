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
import type { LifecycleStep } from "@/lib/quotes/lifecycle";

/** Would the server refuse a payment on this quote right now? `null` = record as today. */
export function recordPaymentBlock(q: PaymentApprovalFacts): { reason: string } | null {
  return paymentApprovalBlock(q);
}

/** What pressing Record payment does: the approval notice while blocked, else the form. */
export function recordPaymentStep(block: { reason: string } | null): "notice" | "form" {
  return block ? "notice" : "form";
}

/**
 * R-2334: the progress line while the same block holds — Sent ✓ → Owner approval (current) →
 * Signed …, instead of Signed looking like the customer's move. Only on a live quote that is
 * already sent; otherwise (no block, dead, draft) the steps come back unchanged.
 */
export function withApprovalStep<S extends LifecycleStep>(
  steps: readonly S[],
  block: { reason: string } | null,
  dead: boolean,
): S[] {
  const sentIdx = steps.findIndex((s) => s.stage === "sent");
  if (!block || dead || sentIdx < 0 || steps[sentIdx].state !== "done") return [...steps];
  const approval = {
    stage: "approval", label: "Owner approval", state: "current",
    detail: "Waiting for the owner's approval — the quote is below cost.",
  } as S;
  const rest = steps.slice(sentIdx + 1).map((s) => (s.state === "current" ? { ...s, state: "todo" } : s) as S);
  return [...steps.slice(0, sentIdx + 1), approval, ...rest];
}

type HeaderBadge ={ kind: "muted" | "success" | "warning" | "danger" | "info"; label: string };

/** The header status: the list's "Needs approval" while the quote waits for sign-off, else `base`. */
export function quoteHeaderStatus(
  q: Parameters<typeof unifiedStatus>[0],
  base: HeaderBadge,
  today: string = istToday(),
): HeaderBadge {
  const listed = unifiedStatus(q, today);
  return listed.label === NEEDS_APPROVAL_LABEL ? listed : base;
}
