/**
 * Read a saved quote's economics for the approval matrix.
 *
 * The quote builder computes these while you type; this reads them back off a stored
 * row. The two must agree, so both derive the same way — list total from `list_rate`
 * (frozen at add time), payable from `rate` (what was negotiated), and the gap between
 * them IS the discount. Recomputing from `quotes.discount_pct` instead would miss every
 * discount given by editing a rate, which is how reps actually discount here.
 */
import type { Quote, QuoteLineItem } from "@/lib/supabase/database.types";
import type { QuoteEconomics, ApprovalRecord } from "./approval";
import { lineCostUnknown } from "./line-cost";

export function lineEconomics(lines: readonly QuoteLineItem[]): QuoteEconomics {
  let subtotal = 0;
  let listTotal = 0;
  let totalCost = 0;
  let costUnknown = false;

  for (const l of lines) {
    const gross = l.qty * l.rate;
    subtotal  += gross - Math.round(gross * ((l.discount_pct ?? 0) / 100));
    /* list_rate falls back to rate, not to zero: an older line without a frozen list
       price was never discounted, so its list IS its rate. Falling back to 0 would
       report every legacy quote as a 100% discount. */
    listTotal += l.qty * (l.list_rate ?? l.rate);
    totalCost += l.qty * l.cost;
    /* R-388: one rule (lib/quotes/line-cost.ts) — our own support plan at ₹0 is a KNOWN
       cost, not "no vendor cost"; a vendor line at ₹0 is still unknown. */
    if (lineCostUnknown(l)) costUnknown = true;
  }

  return { subtotal, listTotal, totalCost, costUnknown };
}

export function quoteEconomics(quote: Pick<Quote, "line_items">): QuoteEconomics {
  return lineEconomics(quote.line_items ?? []);
}

export function quoteApprovalRecord(
  quote: Pick<Quote,
    | "approval_status" | "approval_tier" | "approval_requested_by" | "approved_by"
    | "approved_discount_bps" | "approved_margin_bps" | "approval_rejection_reason">,
): ApprovalRecord {
  return {
    status: quote.approval_status ?? "not_required",
    tier: quote.approval_tier ?? null,
    requestedBy: quote.approval_requested_by ?? null,
    approvedBy: quote.approved_by ?? null,
    approvedDiscountBps: quote.approved_discount_bps ?? null,
    approvedMarginBps: quote.approved_margin_bps ?? null,
    rejectionReason: quote.approval_rejection_reason ?? null,
  };
}
