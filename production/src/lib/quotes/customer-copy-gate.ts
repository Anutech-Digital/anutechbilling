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
 * rule lives here now and every path refuses with the same message and the same fix link.
 * It needs the buyer and the seller (`parties`): a caller that passes none gets the approval
 * rule alone. It applies while the quote is still on its way (draft / sent / viewed) and no
 * invoice exists — an issued invoice keeps its frozen head.
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

/** Statuses on the way to the customer — the place-of-supply rule applies to these only. */
const SUPPLY_OPEN_STATUSES = new Set(["draft", "sent", "viewed"]);

export function customerCopyBlock(quote: CustomerCopyQuote, parties?: CustomerCopyParties | null): CustomerCopyBlock | null {
  return approvalBlock(quote) ?? (parties ? supplyBlock(quote, parties) : null);
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

function supplyBlock(quote: CustomerCopyQuote, parties: CustomerCopyParties): CustomerCopyBlock | null {
  if (!SUPPLY_OPEN_STATUSES.has(quote.status) || quote.invoice_id) return null;
  const pos = quotePlaceOfSupply({
    customer: parties.customer ?? null,
    lead: quote.customer_id ? null : (parties.lead ?? null),
    quote,
    seller: parties.seller,
  });
  if (pos.head.kind === "seller_state_missing") {
    const fix = companyStateFixFor(parties.role);
    const nextStep = fix.description.replace(/\.$/, "");
    return { kind: "company_state", reason: `${fix.title}.`, nextStep, message: `${fix.title}. ${nextStep}`, action: fix.action };
  }
  if (!supplyStateMissing({ isExport: pos.isExport, buyerStateCode: pos.posCode })) return null;
  const name = parties.customer?.name || quote.customer_name || "This customer";
  const action: CustomerCopyNextStep = quote.customer_id
    ? { label: "Set the customer's state", href: `/customers/${quote.customer_id}` }
    : quote.lead_id
      ? { label: "Set the lead's state", href: `/leads?lead=${encodeURIComponent(quote.lead_id)}` }
      : { label: "Pick the customer's state", href: `/quotes/${encodeURIComponent(quote.id ?? "")}/edit` };
  const where = quote.customer_id ? "on the customer page" : quote.lead_id ? "on the lead" : "on the quote";
  const reason = `${name} has no state on record — the state decides CGST + SGST or IGST.`;
  const nextStep = `${action.label} ${where}, then send`;
  return { kind: "customer_state", reason, nextStep, message: `${reason} ${nextStep}`, action };
}

/** The columns customerCopyBlock reads — for a route's `.select(...)`. */
export const CUSTOMER_COPY_COLUMNS =
  "status, line_items, approval_status, approval_tier, approval_requested_by, approved_by, approved_discount_bps, approved_margin_bps, approval_rejection_reason, " +
  "id, customer_id, lead_id, customer_name, prospect_state_code, prospect_country, invoice_id";
