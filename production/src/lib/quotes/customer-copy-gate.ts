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
 * R-2448 — and when the place of supply is unknown. R-2442 made Send refuse a quote whose
 * buyer has no state ("Not known yet", R-2363) or whose company has none: CGST + SGST vs IGST
 * is undecided and generate_invoice refuses the GST invoice after the customer has paid. Mark
 * as sent, the PDF / WhatsApp link and "Copy link instead" still handed that quote over, so the
 * rule lives here now: Send, Mark as sent, the PDF link and the quote page's buttons (Download
 * PDF, WhatsApp, Copy customer link) refuse with the same message and the same fix link. It needs
 * the buyer and the seller (`parties`): a caller that passes none gets the approval rule alone
 * (the public signed-PDF route and the inbound auto-quote sender do not load them — not gated).
 * It applies to every quote except an accepted / rejected one, and never once an invoice exists
 * (an issued invoice keeps its frozen head).
 *
 * Internal Preview is not a customer copy and is never blocked.
 */
import type { Quote } from "@/lib/supabase/database.types";
import { canSend, requiredApproval } from "./approval";
import { quoteApprovalRecord, quoteEconomics } from "./approval-economics";
import { quotePlaceOfSupply, type BuyerPlace } from "./quote-place-of-supply";
import { supplyStateMissing } from "./quote-assist";
import { companyStateFixFor } from "@/lib/onboarding/setup-links";

export type CustomerCopyQuote = Pick<Quote,
  | "status" | "line_items"
  | "approval_status" | "approval_tier" | "approval_requested_by" | "approved_by"
  | "approved_discount_bps" | "approved_margin_bps" | "approval_rejection_reason">
  /* R-2448: who the quote is for — read by the place-of-supply half (only with `parties`). */
  & Partial<Pick<Quote,
  | "id" | "customer_id" | "lead_id" | "customer_name" | "prospect_state_code" | "prospect_country" | "invoice_id">>;

/** R-2448: the buyer and seller the place of supply is decided from (as the send route reads them). */
export interface CustomerCopyParties {
  /** The picked customer's row (null when the quote has none, or it did not load). */
  customer?: (BuyerPlace & { name?: string | null }) | null;
  /** The lead the quote was raised on — used only when there is no customer. */
  lead?: BuyerPlace | null;
  /** The company's own state / GSTIN. */
  seller: { state_code?: string | null; gstin?: string | null };
  /** The signed-in user's role — picks the company-state fix (only the owner can set it). */
  role?: string | null;
}

export interface CustomerCopyNextStep {
  label: string;
  href: string;
}

export interface CustomerCopyBlock {
  /** Which rule refused: discount / margin approval, the company's state, or the buyer's state. */
  kind: "approval" | "company_state" | "customer_state";
  reason: string;
  nextStep: string;
  /** The whole refusal in one line, no closing full stop (a toast adds its own tail). */
  message: string;
  /** The button that fixes it — the place-of-supply blocks always carry one. */
  action?: CustomerCopyNextStep;
}

/** One short line for a disabled button's tooltip / a refused route. */
export const CUSTOMER_COPY_BLOCKED_TITLE = "Needs approval first — the customer copy is locked until it is approved.";

/** R-2459: a disabled button's tooltip — the short locked line for approval, the whole refusal (with its fix) otherwise. */
export function customerCopyBlockTitle(block: CustomerCopyBlock | null | undefined): string | undefined {
  if (!block) return undefined;
  return block.kind === "approval" ? CUSTOMER_COPY_BLOCKED_TITLE : block.message;
}

/** Closed statuses — the place-of-supply rule leaves these alone (the send route refuses them anyway). */
const SUPPLY_CLOSED_STATUSES = new Set(["accepted", "rejected"]);

export function customerCopyBlock(quote: CustomerCopyQuote, parties?: CustomerCopyParties | null): CustomerCopyBlock | null {
  return approvalBlock(quote) ?? (parties ? supplyCopyBlock(quote, parties) : null);
}

/**
 * R-2448: true when the place-of-supply half can refuse this quote — a route checks it before it
 * spends queries loading the buyer and the seller.
 */
export function supplyRuleApplies(quote: Pick<CustomerCopyQuote, "status" | "invoice_id">): boolean {
  return !SUPPLY_CLOSED_STATUSES.has(quote.status) && !quote.invoice_id;
}

function approvalBlock(quote: CustomerCopyQuote): CustomerCopyBlock | null {
  const record = quoteApprovalRecord(quote);
  const inLoop = quote.status === "draft" || record.status === "pending" || record.status === "rejected";
  if (!inLoop) return null;
  const gate = canSend(record, requiredApproval(quoteEconomics(quote)));
  if (gate.allowed) return null;
  return {
    kind: "approval",
    reason: gate.reason,
    nextStep: gate.nextStep,
    message: `Needs approval first — ${gate.reason} ${gate.nextStep}`,
  };
}

/** The place-of-supply half alone — for a route that has already run the approval half. */
export function supplyCopyBlock(quote: CustomerCopyQuote, parties: CustomerCopyParties): CustomerCopyBlock | null {
  if (!supplyRuleApplies(quote)) return null;
  const pos = quotePlaceOfSupply({
    customer: parties.customer ?? null,
    lead: quote.customer_id ? null : (parties.lead ?? null),
    quote,
    seller: parties.seller,
  });
  if (pos.head.kind === "seller_state_missing") {
    /* Not companyStateFixFor's description: it says "The quote was not sent", and this line is
       also a disabled button's tooltip and the PDF link's refusal. */
    const fix = companyStateFixFor(parties.role);
    const reason = `${fix.title}. GST needs it to choose CGST + SGST or IGST.`;
    const nextStep = parties.role === "owner"
      ? "Set it once in Settings → Company first"
      : "Only the owner can set it — ask the owner to set the company state in Settings → Company first";
    return { kind: "company_state", reason, nextStep, message: `${reason} ${nextStep}`, action: fix.action };
  }
  if (!supplyStateMissing({ isExport: pos.isExport, buyerStateCode: pos.posCode })) return null;
  const name = parties.customer?.name || quote.customer_name || "This customer";
  /* R-2459: a typed prospect's state lives on the quote itself, and only a DRAFT opens in the
     editor — a sent quote's /edit says "can't be edited" (dead end, Chrome check 4 Nov,
     Q-F588-27-0008). Past draft the way to a state is Revise: a draft copy where it is picked,
     which replaces this quote once sent. The quote page reads `?revise=1` and asks first. */
  const quoteId = encodeURIComponent(quote.id ?? "");
  const [action, where]: [CustomerCopyNextStep, string] = quote.customer_id
    ? [{ label: "Set the customer's state", href: `/customers/${quote.customer_id}` }, "on the customer page"]
    : quote.lead_id
      ? [{ label: "Set the lead's state", href: `/leads?lead=${encodeURIComponent(quote.lead_id)}` }, "on the lead"]
      : quote.status === "draft"
        ? [{ label: "Pick the customer's state", href: `/quotes/${quoteId}/edit` }, "on the quote"]
        : [{ label: "Revise the quote", href: `/quotes/${quoteId}?revise=1` }, "and pick the customer's state on the new draft"];
  const reason = `${name} has no state on record — the state decides CGST + SGST or IGST.`;
  const nextStep = `${action.label} ${where} first`;
  return { kind: "customer_state", reason, nextStep, message: `${reason} ${nextStep}`, action };
}

/** The columns customerCopyBlock reads — for a route's `.select(...)`. */
export const CUSTOMER_COPY_COLUMNS =
  "status, line_items, approval_status, approval_tier, approval_requested_by, approved_by, approved_discount_bps, approved_margin_bps, approval_rejection_reason";
