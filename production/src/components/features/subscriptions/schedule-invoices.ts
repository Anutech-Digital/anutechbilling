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
import { billedElsewhere, billedElsewhereLabel, type ExternalSourceFields } from "@/lib/subscriptions/billed-elsewhere";

export interface ScheduleInvoice {
  invoiceId: string;
  /** invoices.status — "paid", "pending", "overdue", … ("external" for a period billed elsewhere) */
  status: string;
  /** R-1763: billed in another system (Zoho Books) — the tag text, e.g. "Billed in Zoho · INV-000871". */
  externalLabel?: string;
  /** R-1683: the invoice's own ₹ ex-GST (taxable value) — shown instead of the mrr forecast. */
  exGst?: number;
}

/** R-1683: a renewal quote's invoice — `termDate` = quotes.renewal_term_date (the renewal_date it renewed). */
export interface RenewalInvoice extends ScheduleInvoice {
  termDate: string | null;
}

/** R-1683: an add-seats quote's invoice — a one-off pro-rata charge inside a term, not a schedule row. */
export interface AddSeatInvoice extends ScheduleInvoice {
  invoiceDate: string | null;
}

export interface InstalmentRow {
  term_start: string;
  period_index: number;
  invoice_id: string | null;
  invoice_status: string | null;
  /** R-1683: that invoice's ₹ ex-GST, when loaded. */
  invoice_ex_gst?: number | null;
}

export function scheduleInvoices(args: {
  periods: BillingPeriod[];
  startDate: string | null;
  /** The sale quote's whole-term invoice, when there is one (and it is not void). */
  saleInvoice: ScheduleInvoice | null;
  instalments: InstalmentRow[];
  /** R-1763: an imported subscription — its periods up to billed_externally_until were billed in Zoho. */
  source?: ExternalSourceFields | null;
  /** R-1683: renewal quotes' invoices — a paid renewal bills the whole term it opened. */
  renewals?: RenewalInvoice[];
}): Map<number, ScheduleInvoice> {
  const out = new Map<number, ScheduleInvoice>();
  const first = args.periods[0];
  if (!first) return out;

  const termStart = first.periodStart;
  const keys = new Set([termStart, addDaysISO(termStart, 1)]);
  for (const r of args.instalments) {
    if (!r.invoice_id || !keys.has(r.term_start.slice(0, 10))) continue;
    if (r.invoice_status === "void") continue;
    out.set(r.period_index, {
      invoiceId: r.invoice_id, status: r.invoice_status ?? "pending",
      ...(r.invoice_ex_gst != null ? { exGst: r.invoice_ex_gst } : {}),
    });
  }

  const isSaleTerm = args.startDate != null && args.startDate.slice(0, 10) === termStart;
  if (args.saleInvoice && isSaleTerm && args.periods.length === 1 && !out.has(first.index)) {
    out.set(first.index, args.saleInvoice);
  }
  /* R-1683 (staging T-15): a renewal quote is always a whole term (split-billed subscriptions get
     none — R-808), made for the renewal_date it renews. The term it opened starts the day after
     that date (inclusive last day, since 11 Sep 2026) or on it (anniversary rows). Its paid
     invoice was invisible here, so the renewed term read "next" — as if not billed yet. */
  if (args.periods.length === 1 && !out.has(first.index)) {
    const r = (args.renewals ?? []).find((x) => x.status !== "void" && x.termDate != null
      && (x.termDate.slice(0, 10) === termStart || addDaysISO(x.termDate.slice(0, 10), 1) === termStart));
    if (r) out.set(first.index, { invoiceId: r.invoiceId, status: r.status, exGst: r.exGst });
  }
  /* R-1763: a period Zoho already billed is not "scheduled" and never "next" — it is billed. */
  if (args.source) {
    for (const p of args.periods) {
      if (out.has(p.index) || !billedElsewhere(args.source, p.periodStart)) continue;
      out.set(p.index, { invoiceId: (args.source.external_ref ?? "").trim(), status: "external", externalLabel: billedElsewhereLabel(args.source) });
    }
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

/**
 * R-1685: the schedule header counted ROWS and called them invoices — a back-dated monthly term
 * with no invoice raised read "1 invoice" beside "date passed" (staging T-16). Rows are billing
 * dates; how many of them really have an invoice is said separately, and only when there is one.
 */
export function scheduleCountLabel(rows: number, invoicedCount: number, addSeatCount = 0): string {
  const dates = `${rows} billing ${rows === 1 ? "date" : "dates"}`;
  const base = invoicedCount > 0 ? `${dates} · ${invoicedCount} invoiced` : dates;
  /* R-1683: an add-seats invoice is not a billing date, but it IS money billed in this term. */
  return addSeatCount > 0 ? `${base} · ${addSeatCount} added-seats ${addSeatCount === 1 ? "invoice" : "invoices"}` : base;
}

/**
 * R-1683 (staging T-12): the add-seats invoices raised INSIDE this term (invoice date from the
 * term's first day up to its exclusive end), void ones left out. INV-0074 (5 seats, ₹50,905) was
 * on no row at all, so the term looked billed at ₹1,29,600 while the header said ₹1,94,400.
 */
export function termAddSeatInvoices(periods: BillingPeriod[], addSeats: readonly AddSeatInvoice[]): AddSeatInvoice[] {
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) return [];
  return addSeats.filter((i) => i.status !== "void" && i.invoiceDate != null
    && i.invoiceDate.slice(0, 10) >= first.periodStart && i.invoiceDate.slice(0, 10) < last.periodEnd);
}

/**
 * R-1683: the term's ₹ ex-GST as the card shows it — an invoiced row counts what its invoice says
 * (when known), a row not invoiced yet its forecast, plus the term's add-seats invoices. Before,
 * the header was mrr × months alone, which already counts the added seats for the WHOLE year, so
 * it matched neither the invoices nor the forecast.
 */
export function shownTermTotal(
  periods: BillingPeriod[],
  invoiced: Map<number, ScheduleInvoice>,
  extras: readonly AddSeatInvoice[] = [],
): number {
  let total = 0;
  for (const p of periods) total += invoiced.get(p.index)?.exGst ?? p.amount;
  for (const x of extras) total += x.exGst ?? 0;
  return total;
}
