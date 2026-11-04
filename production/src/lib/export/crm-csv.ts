/**
 * Core CRM entities ka CSV — "apna data le sakta hoon?" ka jawab (audit B7).
 *
 * 1 Sep 2026 tak export sirf accounting-reports se nikalta tha (ledger,
 * P&L…) — customers/leads/quotes/invoices/payments/subscriptions me se KISI
 * ka CSV nahi tha. Jo prospect poochhta "lock-in to nahi?", uske liye jawab
 * aadha tha.
 *
 * Niyam wahi jo lib/csv.ts ka hai: amounts KACCHE integer ₹ (Excel jod
 * sake), tareekh ISO jaisi aati hai waisi, aur formula-injection ka guard
 * downloadCSV/buildCSV me pehle se hai — yahan sirf rows bante hain, pure
 * aur testable.
 */
import type { Customer, Lead, Quote, Invoice, Payment, Subscription } from "@/lib/supabase/database.types";

type Cell = string | number;

const s = (v: string | number | null | undefined): Cell => v ?? "";

export const CUSTOMERS_CSV_HEADERS = [
  "Name", "Display name", "Customer no", "Type", "Domain", "GSTIN", "State", "State code",
  "Country", "Contact name", "Contact email", "Contact phone", "Payment terms (days)",
  "TAN", "TDS section", "TDS rate %", "Since", "Notes",
] as const;

export function customersCsvRows(rows: readonly Customer[]): Cell[][] {
  return rows.map((c) => [
    s(c.name), s(c.display_name), s(c.customer_number), s(c.customer_type), s(c.domain),
    s(c.gstin), s(c.state), s(c.state_code), s(c.country), s(c.contact_name),
    s(c.contact_email), s(c.contact_phone), s(c.payment_terms_days),
    s(c.tan), s(c.tds_default_section), s(c.tds_default_rate_pct), s(c.since), s(c.notes),
  ]);
}

export const LEADS_CSV_HEADERS = [
  "Company", "Contact", "Email", "Phone", "Plan", "Seats", "Value (₹)", "Stage",
  "Source", "Lost reason", "Created",
] as const;

/* Only the columns it writes — so the leads page can export its slim rows (S40). */
type CsvLead = Pick<Lead, "company" | "contact_name" | "contact_email" | "contact_phone" | "plan"
  | "seats" | "value" | "stage" | "source" | "lost_reason" | "created_at">;

export function leadsCsvRows(rows: readonly CsvLead[]): Cell[][] {
  return rows.map((l) => [
    s(l.company), s(l.contact_name), s(l.contact_email), s(l.contact_phone), s(l.plan),
    s(l.seats), s(l.value), s(l.stage), s(l.source), s(l.lost_reason), s(l.created_at),
  ]);
}

export const QUOTES_CSV_HEADERS = [
  "Quote no", "Customer", "Status", "Payment status", "Subtotal (₹)", "GST rate %",
  "Total (₹)", "Payment frequency", "Created", "Expires",
] as const;

export function quotesCsvRows(rows: readonly Quote[]): Cell[][] {
  return rows.map((q) => [
    s(q.id), s(q.customer_name), s(q.status), s(q.payment_status), s(q.subtotal),
    s(q.tax_rate), s(q.amount), s(q.billing_cycle), s(q.created_date), s(q.expires_date),
  ]);
}

export const INVOICES_CSV_HEADERS = [
  "Invoice no", "Customer", "Status", "Invoice date", "Due date",
  "Taxable (₹)", "GST (₹)", "Total (₹)", "Paid (₹)", "IRN",
] as const;

export function invoicesCsvRows(rows: readonly Invoice[]): Cell[][] {
  return rows.map((i) => [
    s(i.id), s(i.customer_name), s(i.status), s(i.invoice_date), s(i.due_date),
    s(i.taxable_value), s(i.tax_amount), s(i.amount), s(i.paid_amount), s(i.gst_irn),
  ]);
}

export const PAYMENTS_CSV_HEADERS = [
  "Payment id", "Quote no", "Amount (₹)", "Method", "Reference", "Status",
  "Received at", "Receipt voucher", "Refunded at", "Refund voucher", "Refund reason",
] as const;

export function paymentsCsvRows(rows: readonly Payment[]): Cell[][] {
  return rows.map((p) => [
    s(p.id), s(p.quote_id), s(p.amount), s(p.method), s(p.reference), s(p.status),
    s(p.received_at), s(p.receipt_voucher_no),
    s(p.refunded_at), s((p as { refund_voucher_no?: string | null }).refund_voucher_no), s(p.refund_reason),
  ]);
}

export const SUBSCRIPTIONS_CSV_HEADERS = [
  "Customer", "Plan", "Vendor", "Domain", "Seats", "Used", "MRR (₹)", "Status",
  "Start", "Renewal", "Outstanding (₹)",
] as const;

export function subscriptionsCsvRows(rows: readonly Subscription[]): Cell[][] {
  return rows.map((x) => [
    s(x.customer_name), s(x.plan), s(x.vendor), s(x.domain), s(x.seats), s(x.used),
    s(x.mrr), s(x.status), s(x.start_date), s(x.renewal_date), s(x.outstanding_amount),
  ]);
}
