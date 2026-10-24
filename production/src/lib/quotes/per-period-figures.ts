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
import type { BillingCycle } from "@/lib/supabase/database.types";
import { cycleInvoicesPerYear } from "@/lib/quotes/billing";
import { lineIsPerInvoice, perInvoiceDivisor, annualContractValue } from "@/lib/pdf/invoice-divisor";
import { quoteInstalmentPlan, type QuoteInstalmentPlan } from "@/lib/billing/instalments";
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
