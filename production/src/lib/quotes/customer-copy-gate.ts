/**
 * R-1669 — may a copy of this quote go to the CUSTOMER right now?
 *
 * Staging 19 Oct (Q-5F40-27-0091): "Save & send" correctly stopped an 18%-under-list quote
 * with "needs approval first", but Download PDF and Send on WhatsApp stayed live — a rep
 * could hand the customer the discounted quote before anyone approved it. Every path that
 * puts the quote in the customer's hands (PDF download, WhatsApp, the server PDF link,
 * email) asks this one question, so the buttons and the routes cannot disagree.
 *
 * Blocked when the approval matrix says it may not be sent (canSend — the same rule as
 * "Mark as sent") AND the quote is still in the approval loop: a draft, or one whose
 * approval is pending / rejected. A quote sent or accepted before the matrix existed is
 * not pulled back by it — its PDF stays downloadable.
 *
 * Internal Preview is not a customer copy and is never blocked.
 */
import type { Quote } from "@/lib/supabase/database.types";
import { canSend, requiredApproval } from "./approval";
import { quoteApprovalRecord, quoteEconomics } from "./approval-economics";

export type CustomerCopyQuote = Pick<Quote,
  | "status" | "line_items"
  | "approval_status" | "approval_tier" | "approval_requested_by" | "approved_by"
  | "approved_discount_bps" | "approved_margin_bps" | "approval_rejection_reason">;

export interface CustomerCopyBlock {
  reason: string;
  nextStep: string;
}

/** One short line for a disabled button's tooltip / a refused route. */
export const CUSTOMER_COPY_BLOCKED_TITLE = "Needs approval first — the customer copy is locked until it is approved.";

export function customerCopyBlock(quote: CustomerCopyQuote): CustomerCopyBlock | null {
  const record = quoteApprovalRecord(quote);
  const inLoop = quote.status === "draft" || record.status === "pending" || record.status === "rejected";
  if (!inLoop) return null;
  const gate = canSend(record, requiredApproval(quoteEconomics(quote)));
  if (gate.allowed) return null;
  return { reason: gate.reason, nextStep: gate.nextStep };
}

/** The columns customerCopyBlock reads — for a route's `.select(...)`. */
export const CUSTOMER_COPY_COLUMNS =
  "status, line_items, approval_status, approval_tier, approval_requested_by, approved_by, approved_discount_bps, approved_margin_bps, approval_rejection_reason";
