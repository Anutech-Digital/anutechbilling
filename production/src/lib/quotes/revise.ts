/**
 * Revising a SENT quote (R-482 / board R-448, 9 Oct 2026).
 *
 * Abhishek's Scenario 5: the customer asked for 12 seats instead of 15. A sent quote has no
 * Edit, so the only way was "Duplicate & edit" — a brand-new quote with a new number, while
 * the old one stayed 'sent'. The customer's old link still offered "Accept · ₹57,348", and a
 * payment recorded on it made a second subscription.
 *
 * A revision instead keeps the family number (Q-…-0005 → Q-…-0005-R2 → Q-…-0005-R3). "Revise"
 * copies the quote into a new DRAFT and opens it in the draft editor; once that draft is SENT
 * the database marks the old one replaced (trg_quote_revision_sent), so it can never be
 * accepted again. Only a quote that is out with the customer and has no money on it
 * can be revised — anything with a payment or invoice is history and stays as it is.
 */
import type { Quote } from "@/lib/supabase/database.types";
import { addDaysISO } from "@/lib/dates/ist";

export interface RevisableQuote {
  id: string;
  status: string;
  payment_status?: string | null;
  invoice_id?: string | null;
  superseded_by?: string | null;
  revision_of?: string | null;
  revision_no?: number | null;
}

export type ReviseCheck = { ok: true } | { ok: false; reason: string };

/** Can this quote be revised? `received` = ₹ recorded against it so far. */
export function canReviseQuote(q: RevisableQuote, received: number): ReviseCheck {
  if (q.superseded_by) return { ok: false, reason: `Already replaced by ${q.superseded_by}.` };
  if (q.status === "draft") return { ok: false, reason: "A draft can be edited directly." };
  if (q.status !== "sent" && q.status !== "viewed") {
    return { ok: false, reason: `Only a sent quote can be revised (this one is ${q.status}).` };
  }
  if (q.invoice_id || received > 0 || q.payment_status === "received" || q.payment_status === "partial" || q.payment_status === "invoiced") {
    return { ok: false, reason: "This quote has a payment or invoice, so it can't be revised." };
  }
  return { ok: true };
}

export interface RevisionId {
  /** The new quote's id, e.g. Q-ADPL-27-0005-R2. */
  id: string;
  /** First quote of the family — stored on the new quote as `revision_of`. */
  revisionOf: string;
  /** 2 for the first revision. */
  revisionNo: number;
}

/** The id and family fields for the next revision of `q`. */
export function nextRevision(q: Pick<RevisableQuote, "id" | "revision_of" | "revision_no">): RevisionId {
  const root = q.revision_of || q.id;
  const revisionNo = Math.max(1, q.revision_no ?? 1) + 1;
  return { id: `${root}-R${revisionNo}`, revisionOf: root, revisionNo };
}

/** The quote columns a revision copies — terms, lines and parties; never money, approval or status. */
export type RevisionSource = RevisableQuote & Pick<Quote,
  | "tenant_id" | "customer_id" | "customer_name" | "lead_id" | "owner_id" | "plan" | "seats" | "amount"
  | "line_items" | "subtotal" | "total_cost" | "discount_pct" | "tax_rate" | "notes" | "is_renewal" | "domain"
  | "extension_months" | "is_extension" | "is_add_seats" | "currency" | "exchange_rate" | "is_one_off"
  | "billing_cycle" | "payment_terms_days" | "terms_conditions" | "prospect_state_code" | "prospect_state"
  | "prospect_country" | "fx_source" | "fx_date" | "created_date" | "expires_date">;

/**
 * The new DRAFT row for a revision: a copy of the quote's terms under the next family id.
 * It is opened in the draft editor; the old quote is replaced only when this one is SENT
 * (database trigger trg_quote_revision_sent). Validity keeps the same length as the original
 * (30 days when unknown), counted from `todayIso`.
 */
export function revisionDraft(q: RevisionSource, next: RevisionId, todayIso: string) {
  const validity = q.created_date && q.expires_date
    ? Math.max(1, Math.round((Date.parse(q.expires_date) - Date.parse(q.created_date)) / 86_400_000))
    : 30;
  return {
    id: next.id,
    tenant_id: q.tenant_id,
    status: "draft" as const,
    revision_of: next.revisionOf,
    revision_no: next.revisionNo,
    customer_id: q.customer_id,
    customer_name: q.customer_name,
    lead_id: q.lead_id,
    owner_id: q.owner_id,
    plan: q.plan,
    seats: q.seats,
    amount: q.amount,
    line_items: q.line_items,
    subtotal: q.subtotal,
    total_cost: q.total_cost,
    discount_pct: q.discount_pct,
    tax_rate: q.tax_rate,
    notes: q.notes,
    is_renewal: q.is_renewal,
    domain: q.domain,
    extension_months: q.extension_months,
    is_extension: q.is_extension,
    is_add_seats: q.is_add_seats,
    currency: q.currency,
    exchange_rate: q.exchange_rate,
    is_one_off: q.is_one_off,
    billing_cycle: q.billing_cycle,
    payment_terms_days: q.payment_terms_days,
    terms_conditions: q.terms_conditions,
    prospect_state_code: q.prospect_state_code,
    prospect_state: q.prospect_state,
    prospect_country: q.prospect_country,
    fx_source: q.fx_source,
    fx_date: q.fx_date,
    created_date: todayIso,
    expires_date: addDaysISO(todayIso, validity),
  };
}
