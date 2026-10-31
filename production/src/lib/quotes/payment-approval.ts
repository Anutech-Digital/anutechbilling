/**
 * R-2213 — a BELOW-COST quote takes no money until the owner approves it.
 *
 * July reconcile on staging (R-2094): Manage-seats quotes priced below cost showed "Needs approval"
 * on the quote page, yet bank credits were reconciled to them and the quote then read "Sent". The
 * approval matrix (./approval.ts) lived only on screen; Manage seats never wrote approval_status,
 * and no money RPC looked at it.
 *
 * Pardeep's rule (card decision, 31 Oct):
 *   • Money is refused only when the quote is BELOW COST (margin < 0 by lineEconomics) and not
 *     approved. Thinner margins, discounts and unknown cost keep the "Needs approval" flow but are
 *     paid as before.
 *   • The server that builds a quote outside the builder (Manage seats) writes the approval state
 *     from the same TS rule — `serverApprovalColumns` — so the DB row says what the screen says.
 *     The DB guard (trigger tg_payments_quote_approval) only reads quotes.below_cost +
 *     approval_status; it never recomputes margins.
 *   • Razorpay money is never refused (the DB lets it through; the quote stays pending).
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { marginBps, requiredApproval } from "./approval";
import { lineEconomics } from "./approval-economics";

/** The screen word for a quote waiting on sign-off — the same word approval.ts approvalBadge shows. */
export const NEEDS_APPROVAL_LABEL = "Needs approval";

/** Below cost: margin is KNOWN and under 0%. Unknown cost is not "below cost". */
export function linesBelowCost(lines: readonly QuoteLineItem[]): boolean {
  const m = marginBps(lineEconomics(lines));
  return m !== null && m < 0;
}

/**
 * The approval columns a server-built quote is inserted with — the same rule the quote page shows.
 * Tier "none" → not_required. Otherwise pending, in the approvals queue under `requestedBy`
 * (nobody approves their own quote — another owner clears it).
 */
export function serverApprovalColumns(
  lines: readonly QuoteLineItem[],
  requestedBy: string | null,
  nowIso: string = new Date().toISOString(),
): {
  approval_status: "not_required" | "pending";
  approval_tier: "manager" | "owner" | null;
  approval_requested_by: string | null;
  approval_requested_at: string | null;
  below_cost: boolean;
} {
  const need = requiredApproval(lineEconomics(lines));
  const below = linesBelowCost(lines);
  if (need.tier === "none") {
    return { approval_status: "not_required", approval_tier: null, approval_requested_by: null, approval_requested_at: null, below_cost: below };
  }
  return {
    approval_status: "pending",
    approval_tier: need.tier,
    approval_requested_by: requestedBy,
    approval_requested_at: nowIso,
    below_cost: below,
  };
}

export interface PaymentApprovalFacts {
  id: string;
  below_cost?: boolean | null;
  approval_status?: string | null;
}

/** The DB trigger's refusal, word for word — the sheet shows it before Save is pressed. */
export function belowCostRefusal(quoteId: string): string {
  return `This quote is below cost and waits for the owner's approval. Approve it first (Quotes → ${quoteId} → Approve), then record the payment.`;
}

/**
 * Would the DB refuse money (other than Razorpay) on this quote right now? Mirrors
 * tg_payments_quote_approval exactly: below_cost and not approved.
 */
export function paymentApprovalBlock(q: PaymentApprovalFacts): { reason: string } | null {
  if (!q.below_cost) return null;
  if (q.approval_status === "approved") return null;
  return { reason: belowCostRefusal(q.id) };
}
