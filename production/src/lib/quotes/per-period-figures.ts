/**
 * R-1570 — what ONE invoice of a quote carries, for every document that prints it.
 *
 * The quotation PDF and the covering email both print "per invoice" figures beside a
 * "/month" or "/qtr". Until R-1570 they worked them out separately:
 *
 *   PDF   — perInvoiceDivisor + quoteInstalmentPlan → first instalment ₹4,779/mo
 *   email — the stored YEAR with "/month" after it → "PAYABLE EACH MONTH ₹57,348/month"
 *
 * Same quote (annual_yearly line, billing_cycle monthly, as the auto-quote stores it), one
 * figure twelve times the other. Two places doing the same arithmetic is how a letter and its
 * attachment come to differ — so the arithmetic lives here and both read it.
 *
 * The rules are the PDF's, unchanged (they were the right ones):
 *   - yearly (one invoice a year)        → the stored figures as they are.
 *   - flex line (commitment "monthly")   → stored figures ARE one month; divide by nothing.
 *   - annual commitment, split billing   → ₹ quotes: the first instalment from
 *     lib/billing/instalments (taxable + round(taxable × GST%) — the instalment invoice's own
 *     rounding, R-527); a foreign quote has no plan and divides by invoices-per-year at 2dp.
 */
import type { BillingCycle, QuoteLineItem } from "@/lib/supabase/database.types";
import { lineIsSubscription } from "@/lib/quotes/optional-line";
import { cycleInvoicesPerYear, cycleFromLegacyCommitment } from "@/lib/quotes/billing";
import { rupee } from "@/lib/utils";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { taxableAfterDiscount } from "@/lib/quotes/amounts";
import { isOneTimeQuote } from "@/lib/quotes/service-period";
import { lineIsPerInvoice, perInvoiceDivisor, annualContractValue } from "@/lib/pdf/invoice-divisor";
import { quoteInstalmentPlan, firstLineCommitment, type QuoteInstalmentPlan } from "@/lib/billing/instalments";
import { splitIntraStateTax } from "@/lib/gst/tax-split";

export interface PerPeriodInput {
  cycle: BillingCycle;
  /** The first line's commitment — tells a flex month from an annual year. */
  lineCommitment: string | null | undefined;
  /** The TERM figures as stored on the quote, in the display currency. */
  subtotal: number;
  discount: number;
  taxable:  number;
  tax:      number;
  total:    number;
  /** Effective GST % (0 on an export). */
  taxRate:  number;
  /** A non-₹ quote: figures are in cents (2dp) and there is no instalment plan. */
  foreign?: boolean;
}

export interface PerPeriodFigures {
  invoicesPerYear: number;
  /** More than one invoice a year — print the unit ("/month") beside each figure. */
  perInvoice: boolean;
  /** Flex line: no yearly commitment exists. */
  flex: boolean;
  subtotal: number;
  discount: number;
  taxable:  number;
  tax:      number;
  cgst:     number;
  sgst:     number;
  /** What one invoice asks for, incl GST. */
  gross:    number;
  /** The year's value — the sum of instalments on a split ₹ quote. */
  yearTotal: number;
  /** The dated instalment plan, when the quote has one. */
  plan: QuoteInstalmentPlan | null;
}

export function quotePerPeriodFigures(i: PerPeriodInput): PerPeriodFigures {
  const foreign = i.foreign === true;
  const dRound = (v: number) => (foreign ? Math.round(v * 100) / 100 : Math.round(v));
  const n = cycleInvoicesPerYear(i.cycle);
  const perInvoice = n > 1;
  const flex = lineIsPerInvoice(i.lineCommitment);
  const divisor = perInvoiceDivisor(n, i.lineCommitment);
  const div = (v: number) => (perInvoice ? dRound(v / divisor) : v);

  /* A foreign quote's tax is in cents: split it as whole cents (see QuotePDF R-212 note). */
  const intra = foreign
    ? (({ cgst, sgst }) => ({ cgst: cgst / 100, sgst: sgst / 100 }))(splitIntraStateTax(Math.round(i.tax * 100)))
    : splitIntraStateTax(i.tax);

  const plan = !foreign && perInvoice && !flex
    ? quoteInstalmentPlan({
        cycle: i.cycle, termTaxable: i.taxable, termGross: i.total,
        taxRate: i.taxRate, lineCommitment: i.lineCommitment ?? null, termStart: "2000-01-01",
      })
    : null;
  const first = plan?.lines[0] ?? null;
  const heads = first ? splitIntraStateTax(first.tax) : { cgst: div(intra.cgst), sgst: div(intra.sgst) };

  return {
    invoicesPerYear: n,
    perInvoice,
    flex,
    subtotal: div(i.subtotal),
    discount: div(i.discount),
    taxable:  first ? first.taxable : div(i.taxable),
    tax:      first ? first.tax     : div(i.tax),
    cgst:     heads.cgst,
    sgst:     heads.sgst,
    gross:    first ? first.gross   : div(i.total),
    yearTotal: plan ? plan.instalmentsGross : annualContractValue(i.total, n, i.lineCommitment),
    plan,
  };
}

/* ── R-2580: a Monthly flex sale that also carries a one-time line ──────────────────────
   R-2193 lets one sale hold flex seats (10 × ₹264/month) and a domain (₹1,200 once). The
   stored figures are MONTH 1 — seats + domain, ₹4,531 incl GST — and every later month bills
   the seats only (raise_subscription_billing adds quote_one_time_lines once). The preview and
   the PDF printed ₹4,531 "/month" and ₹54,372 a year. Split it the way the bills are raised:
   the one-time taxable is each line's qty × rate after the quote discount (taxableAfterDiscount;
   quote_one_time_lines rounds the same figure in one step — at most ₹1 apart on a .5) over the lines that are
   not subscriptions (quote_line_is_subscription / lineIsSubscription — the SQL rule, R-2095),
   the month is the rest. Null when there is nothing to split (not flex, or no one-time line,
   or no recurring line). A foreign quote's figures are in its own currency: there the one-time
   share is taken by the lines' ₹ weight, at 2dp. */
export interface FlexOneTimeFigures {
  /** Every month after the first: the recurring lines only. */
  monthly: { subtotal: number; discount: number; taxable: number; tax: number; gross: number };
  /** The one-time lines, billed once with the first invoice. */
  once: { taxable: number; tax: number; gross: number };
}

/** The words the preview and the PDF print for such a sale (one place, so they cannot differ). */
export const FLEX_FIRST_INVOICE = "First invoice (incl. one-time)";
export const FLEX_THEN_MONTHLY = "Then each month";
export const FLEX_ONCE = "One-time, billed once with the first invoice";

/** Is this stored line charged once (not a subscription)? lineIsSubscription's rule, reading the
 *  one_time marker the way SQL does (true or the text "true") — one test for the totals AND the
 *  line rows, so a line can never be once in one and "/mo" in the other. */
export function lineChargedOnce(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const l = raw as { commitment?: unknown; one_time?: unknown };
  return !lineIsSubscription({
    commitment: (typeof l.commitment === "string" ? l.commitment : undefined) as QuoteLineItem["commitment"],
    one_time: l.one_time === true || String(l.one_time ?? "").toLowerCase() === "true",
  });
}

export function flexOneTimeFigures(i: {
  lines: unknown;
  discountPct: number;
  /** The stored (month 1) figures, in the display currency. */
  subtotal: number;
  taxable: number;
  total: number;
  taxRate: number;
  foreign?: boolean;
}): FlexOneTimeFigures | null {
  if (!Array.isArray(i.lines) || firstLineCommitment(i.lines) !== "monthly") return null;
  const dRound = (v: number) => (i.foreign ? Math.round(v * 100) / 100 : Math.round(v));
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  let onceSub = 0, recurringSub = 0, onceTaxableInr = 0;
  for (const raw of i.lines as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw !== "object") continue;
    /* An optional line the customer has not ticked is not in the stored totals (configure.ts). */
    if (raw.optional === true && raw.included_by_default !== true) continue;
    /* A legacy per-line discount is already inside the stored subtotal (QuotePDF netAnnual). */
    const amt = num(raw.qty, 1) * num(raw.rate, 0) * (1 - num(raw.discount_pct, 0) / 100);
    if (!lineChargedOnce(raw)) recurringSub += amt;
    else {
      onceSub += amt;
      onceTaxableInr += taxableAfterDiscount(amt, i.discountPct);
    }
  }
  if (!(onceSub > 0) || !(recurringSub > 0)) return null;
  const share = onceSub / (onceSub + recurringSub);
  const onceTaxable = i.foreign ? dRound(i.taxable * share) : onceTaxableInr;
  const onceSubtotal = i.foreign ? dRound(i.subtotal * share) : Math.round(onceSub);
  const mTaxable = dRound(i.taxable - onceTaxable);
  const mSubtotal = dRound(i.subtotal - onceSubtotal);
  const mTax = dRound((mTaxable * i.taxRate) / 100);
  const mGross = dRound(mTaxable + mTax);
  const onceGross = dRound(i.total - mGross);
  return {
    monthly: { subtotal: mSubtotal, discount: dRound(mSubtotal - mTaxable), taxable: mTaxable, tax: mTax, gross: mGross },
    once: { taxable: onceTaxable, tax: dRound(onceGross - onceTaxable), gross: onceGross },
  };
}

/* ── R-2182: the quote's TOTAL with its period, for the quote detail page ─────────────────
   The Totals card printed the stored figure with "/month" whenever billing_cycle was monthly.
   On an annual commitment the stored figure is the YEAR, so Q-F588-27-0068 (Starter × 10,
   Annual, paid monthly) read "₹38,232 /month" — twelve times the real ₹3,186 — and paid
   quarterly it read "₹38,232" with no unit at all. The bill amount comes from
   quotePerPeriodFigures above (what the PDF and the email print), so the page cannot drift.
   Owner rule (R-2178): under Annual the frequency changes only the amount per bill, never
   the per-month rate — ₹3,186 × 12 = ₹9,558 × 4 = ₹38,232. All figures incl. GST, like the
   Total they replace. */
export type QuotePeriodUnit = "month" | "quarter" | "half-year" | "year";

export interface QuoteTotalPeriods {
  /** What one bill asks for, incl GST. */
  perBill: number;
  /** The period one bill covers; null = paid once (add seats, one-off, month extension). */
  unit: QuotePeriodUnit | null;
  /** The year's total incl GST when the year is paid in parts; null when one bill IS the period. */
  yearTotal: number | null;
  /** R-2222: the Totals rows for ONE bill (what the customer Preview prints), so
   *  subtotal − discount = taxable and taxable + tax = perBill on every period. */
  bill: { subtotal: number; discount: number; taxable: number; tax: number };
}

const CYCLE_UNIT: Record<BillingCycle, QuotePeriodUnit> = {
  monthly: "month", quarterly: "quarter", half_yearly: "half-year", yearly: "year",
};

export function quoteTotalPeriods(
  i: Omit<PerPeriodInput, "cycle"> & { cycle: BillingCycle | null | undefined; oneTime?: boolean },
): QuoteTotalPeriods {
  const stored = { subtotal: i.subtotal, discount: i.discount, taxable: i.taxable, tax: i.tax };
  if (i.oneTime) return { perBill: i.total, unit: null, yearTotal: null, bill: stored };
  /* R-1715 / R-2222: no billing_cycle AND no line commitment — nothing to tell the period
     from, so no unit (a guessed one is the same wrong-unit bug). */
  if (!i.cycle && !i.lineCommitment) return { perBill: i.total, unit: null, yearTotal: null, bill: stored };
  /* No billing_cycle (old quote): the PDF's legacy bridge, never a guessed "/month". */
  const cycle = i.cycle ?? cycleFromLegacyCommitment(i.lineCommitment);
  const pp = quotePerPeriodFigures({ ...i, cycle });
  /* Flex: the stored figures ARE one month, billed monthly — no year commitment to show. */
  if (pp.flex) return { perBill: i.total, unit: "month", yearTotal: null, bill: stored };
  if (!pp.perInvoice) return { perBill: i.total, unit: "year", yearTotal: null, bill: stored };
  /* One bill: taxable + GST from the instalment plan (= perBill); the discount is what is
     left between the bill's subtotal and taxable, so the rows always add up. */
  return {
    perBill: pp.gross, unit: CYCLE_UNIT[cycle], yearTotal: pp.yearTotal,
    bill: { subtotal: pp.subtotal, discount: pp.subtotal - pp.taxable, taxable: pp.taxable, tax: pp.tax },
  };
}

/** "₹3,186" + "/month" + "₹38,232/year" — the words the Totals card and the /quotes list print.
 *  `fmt` formats a ₹ figure (a foreign quote passes its own currency formatter). */
export function quoteTotalPeriodsText(
  t: QuoteTotalPeriods,
  fmt: (inr: number) => string = (v) => rupee(v),
): { perBill: string; unit: string; year: string | null } {
  return {
    perBill: fmt(t.perBill),
    unit: t.unit ? `/${t.unit}` : "",
    year: t.yearTotal == null ? null : `${fmt(t.yearTotal)}/year`,
  };
}

/* ── R-2222: the same, from a quote ROW (the /quotes list reads select * from quotes) ──────
   The list put quoteTotalUnit's "/mo" (billing_cycle only) after the stored YEAR total:
   Q-F588-27-0068 read "₹38,232/mo". The figures are worked out the way the quote page
   works them out (discount on the subtotal, GST = stored total − taxable, R-804). */
export interface QuoteRowForPeriods {
  amount: number | null;
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
  billing_cycle?: string | null;
  line_items?: unknown;
  is_add_seats?: boolean | null;
  is_one_off?: boolean | null;
  is_extension?: boolean | null;
  extension_months?: number | null;
}

export function quoteRowTotalPeriods(q: QuoteRowForPeriods): QuoteTotalPeriods | null {
  if (!q.amount) return null;
  const subtotal = q.subtotal ?? 0;
  const taxRate = q.tax_rate ?? 0;
  const taxable = taxableAfterDiscount(subtotal, q.discount_pct ?? 0);
  const discount = Math.round(subtotal) - taxable;
  const tax = quoteDisplayTax(taxable, taxRate, q.amount);
  const lines = Array.isArray(q.line_items) ? (q.line_items as { commitment?: string | null }[]) : [];
  return quoteTotalPeriods({
    cycle: (q.billing_cycle ?? null) as BillingCycle | null,
    lineCommitment: lines[0]?.commitment ?? null,
    subtotal, discount, taxable, tax, total: q.amount, taxRate,
    oneTime: isOneTimeQuote({
      isAddSeats: q.is_add_seats, isOneOff: q.is_one_off,
      isExtension: q.is_extension, extensionMonths: q.extension_months,
    }),
  });
}
