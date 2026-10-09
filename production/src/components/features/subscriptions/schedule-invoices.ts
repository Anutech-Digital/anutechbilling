/**
 * R-451: which rows of the Billing schedule already have a tax invoice.
 *
 * The card used to decide "billed" vs "next" from the date alone. Abhishek, Scenario 7:
 * Sharma Traders' first year was already invoiced and paid (INV-DEMO-27-0001), yet the
 * schedule showed that same year as the "next" bill — an owner reading it would think a
 * second bill was still to be raised.
 *
 * Two places an invoice for a schedule row can come from:
 *   - the SALE: a yearly subscription's first term is invoiced from the quote it was sold
 *     on (quotes.invoice_id). That invoice covers the term starting on start_date only —
 *     a renewed term is a later quote.
 *   - an INSTALMENT: split-billed terms get one subscription_billings row per period, with
 *     invoice_id once raised. Matched on (term_start, period_index); term_start may be the
 *     pre-R-451 one-day-later key for terms filed before the fix.
 */
import type { BillingPeriod } from "@/lib/billing/schedule";
import { addDaysISO } from "@/lib/dates/ist";

export interface ScheduleInvoice {
  invoiceId: string;
  /** invoices.status — "paid", "pending", "overdue", … */
  status: string;
}

export interface InstalmentRow {
  term_start: string;
  period_index: number;
  invoice_id: string | null;
  invoice_status: string | null;
}

export function scheduleInvoices(args: {
  periods: BillingPeriod[];
  startDate: string | null;
  /** The sale quote's whole-term invoice, when there is one (and it is not void). */
  saleInvoice: ScheduleInvoice | null;
  instalments: InstalmentRow[];
}): Map<number, ScheduleInvoice> {
  const out = new Map<number, ScheduleInvoice>();
  const first = args.periods[0];
  if (!first) return out;

  const termStart = first.periodStart;
  const keys = new Set([termStart, addDaysISO(termStart, 1)]);
  for (const r of args.instalments) {
    if (!r.invoice_id || !keys.has(r.term_start.slice(0, 10))) continue;
    if (r.invoice_status === "void") continue;
    out.set(r.period_index, { invoiceId: r.invoice_id, status: r.invoice_status ?? "pending" });
  }

  const isSaleTerm = args.startDate != null && args.startDate.slice(0, 10) === termStart;
  if (args.saleInvoice && isSaleTerm && args.periods.length === 1 && !out.has(first.index)) {
    out.set(first.index, args.saleInvoice);
  }
  return out;
}

/** The first row with no invoice whose bill date is today or later — the real "next" bill. */
export function nextUninvoiced(periods: BillingPeriod[], invoiced: Map<number, ScheduleInvoice>, todayISO: string): number | null {
  return periods.find((p) => !invoiced.has(p.index) && p.billOn >= todayISO)?.index ?? null;
}

/**
 * R-527: the "next" tag belongs to ONE row on the card. The next-term table computed its own
 * "next" with no invoices to look at, so its first row (9 Oct 2027 on a07416e3) was tagged
 * "next" beside the current term's own next row. The next term may carry the tag only when
 * the current term has no un-invoiced bill left to come.
 */
export function nextTermShowsNext(current: BillingPeriod[], invoiced: Map<number, ScheduleInvoice>, todayISO: string): boolean {
  return nextUninvoiced(current, invoiced, todayISO) === null;
}
