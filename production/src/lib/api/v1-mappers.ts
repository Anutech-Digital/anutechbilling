/**
 * Pure row → integration-spec mappers for /api/v1.
 *
 * These translate ResellerOS DB rows into the exact JSON shapes the DSP spec
 * expects. Kept pure (no I/O) so they're unit-testable.
 *
 * Money note: all amounts are integer INR (rupees), NOT paise — consistent
 * with how ResellerOS stores money internally.
 */
import type {
  Customer as CustomerRow,
  Subscription as SubscriptionRow,
  Invoice as InvoiceRow,
  Quote as QuoteRow,
  Payment as PaymentRow,
} from "@/lib/supabase/database.types";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";

const CURRENCY = "INR";

/** The external id DSP stores/matches on: readable number, else uuid fallback. */
export function billingCustomerId(c: Pick<CustomerRow, "id" | "customer_number">): string {
  return c.customer_number || c.id;
}

export function mapCustomer(c: CustomerRow, hasActiveSubscription: boolean) {
  return {
    billing_customer_id: billingCustomerId(c),
    name:   c.name,
    email:  c.contact_email,
    domain: c.domain,
    status: hasActiveSubscription ? "active" : "inactive",
  };
}

/**
 * List-item shape for the paginated /customers list. Same fields as a single
 * customer, plus `id` (= billing_customer_id) because DSP's list consumer keys
 * on `id`. Both are the customer number (or uuid fallback).
 */
export function mapCustomerListItem(c: CustomerRow, hasActiveSubscription: boolean) {
  const id = billingCustomerId(c);
  return { id, ...mapCustomer(c, hasActiveSubscription) };
}

/** Clamp + parse pagination params. per_page capped to keep responses bounded. */
export function parsePagination(pageRaw: string | null, perPageRaw: string | null) {
  const page    = Math.max(1, Math.floor(Number(pageRaw) || 1));
  const perPage = Math.min(200, Math.max(1, Math.floor(Number(perPageRaw) || 100)));
  return { page, perPage, offset: (page - 1) * perPage };
}

/** Pagination envelope meta. `pages` is at least 1 even when total is 0. */
export function paginationMeta(total: number, page: number, perPage: number) {
  return { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** Coarse billing term from the sub's date span (we don't store a cycle field). */
function subscriptionTerm(s: Pick<SubscriptionRow, "start_date" | "renewal_date">): string {
  if (!s.start_date || !s.renewal_date) return "annual";
  const days = (new Date(s.renewal_date).getTime() - new Date(s.start_date).getTime()) / 86_400_000;
  return days >= 330 ? "annual" : "monthly";
}

const SUB_STATUS: Record<SubscriptionRow["status"], string> = {
  active:    "active",
  paused:    "suspended",
  expired:   "expired",
  cancelled: "cancelled",
};

export function mapSubscription(s: SubscriptionRow) {
  return {
    id:           s.id,
    product:      s.plan,
    plan:         subscriptionTerm(s),
    seats:        s.seats,
    status:       SUB_STATUS[s.status] ?? s.status,
    start_date:   s.start_date,
    renewal_date: s.renewal_date,
    amount:       (s.mrr ?? 0) * 12, // annualised (mrr is ₹/month)
    currency:     CURRENCY,
    // R-1770 (additive): which domain the plan is for, and whose (google/microsoft/hosting…).
    domain:       s.domain ?? null,
    vendor:       s.vendor ?? null,
  };
}

/** Blank text → null, so a consumer never shows an empty name. */
function textOrNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

const INVOICE_STATUS: Record<InvoiceRow["status"], string> = {
  paid:    "paid",
  overdue: "overdue",
  void:    "cancelled",
  pending: "unpaid",
  draft:   "unpaid",
};

export function mapInvoice(i: InvoiceRow, pdfUrl: string | null = null) {
  return {
    id:         i.id,
    number:     i.id, // our id IS the sequential GST number (INV-…)
    amount:     i.amount,
    currency:   CURRENCY,
    status:     INVOICE_STATUS[i.status] ?? i.status,
    issue_date: i.invoice_date,
    due_date:   i.due_date,
    pdf_url:    pdfUrl ?? i.pdf_url,
  };
}

function quoteStatus(q: QuoteRow): string {
  if (q.status === "accepted") return "accepted";
  if (q.status === "expired" || q.status === "rejected") return "expired";
  return "pending";
}

/** A service a quote renews: the subscription whose `renewal_quote_id` is that quote. */
export interface V1QuoteRenews {
  vendor: string;
  domain: string | null;
}

/**
 * `renews` (28 Sep 2026) is included only when the caller looked it up: an empty list then
 * means "this quote renews no subscription" (a new order), which is different from "not
 * looked up". DMS's Renew dialog reads it to offer only the bill for the service being renewed.
 */
export function mapQuote(q: QuoteRow, appUrl: string, pdfUrl: string | null = null, renews?: V1QuoteRenews[]) {
  return {
    id:          q.id,
    amount:      q.amount,
    currency:    CURRENCY,
    status:      quoteStatus(q),
    pdf_url:     pdfUrl ?? q.pdf_url,
    payment_url: quoteAcceptUrl(appUrl, q.id, q.public_token),
    // R-1770 (additive): the quote's expiry date ("valid till") and its name — ResellerOS
    // names a quote by its plan (Quotes list / Combine dialog show `plan`); there is no title column.
    valid_until: q.expires_date ?? null,
    title:       textOrNull(q.plan),
    ...(renews ? { renews } : {}),
  };
}

export function mapPayment(p: PaymentRow, invoiceId: string | null) {
  return {
    id:         p.id,
    amount:     p.amount,
    currency:   CURRENCY,
    reference:  p.reference,
    method:     p.method,
    paid_at:    p.received_at,
    invoice_id: invoiceId,
  };
}
