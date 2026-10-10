/**
 * Which subscriptions bill per period, and what their instalments are.
 *
 * The decisions the billing cron makes, kept pure so they can be tested without a
 * database — the route is left as plumbing.
 *
 * ─── ONLY CYCLES THAT ACTUALLY SPLIT ────────────────────────────────────────
 * A yearly term splits into exactly one period, which is what the quote path
 * already does. Routing yearly through instalments as well would mean two things
 * could invoice the same money, so yearly is deliberately excluded here — the same
 * line the database trigger draws in 20260817110200. If these two ever disagree,
 * either every yearly subscription stops being invoiced or every one is invoiced
 * twice, so they are written to be read together.
 */
import type { BillingCycle, Subscription } from "@/lib/supabase/database.types";
import { subscriptionSchedule } from "./subscription-schedule";
import { buildBillingSchedule } from "./schedule";
import { grossAmount } from "@/lib/quotes/amounts";

/** The cycles that produce more than one invoice per term. */
export const SPLIT_CYCLES: readonly BillingCycle[] = ["monthly", "quarterly", "half_yearly"] as const;

export function isSplitBilled(cycle: BillingCycle | null | undefined): boolean {
  return cycle != null && SPLIT_CYCLES.includes(cycle);
}

/** One instalment, in the shape the subscription_billings row takes. */
export interface PlannedInstalment {
  termStart:     string;
  periodIndex:   number;
  billOn:        string;
  periodStart:   string;
  periodEnd:     string;
  taxableAmount: number;
}

type ScheduleFields = Pick<Subscription, "mrr" | "billing_cycle" | "term_months"> & {
  start_date:   string | null;
  renewal_date: string | null;
};

/**
 * The instalments of the CURRENT term.
 *
 * term_start is the first period's start, and it is what separates one term's
 * instalments from the next term's in the unique key. period_index restarts at 1
 * every term, so without it a renewal's first instalment collides with the original
 * term's first instalment and silently never bills.
 */
export function plannedInstalments(sub: ScheduleFields): PlannedInstalment[] {
  if (!isSplitBilled(sub.billing_cycle)) return [];

  const periods = subscriptionSchedule(sub);
  if (periods.length === 0) return [];

  const termStart = periods[0].periodStart;
  return periods.map((p) => ({
    termStart,
    periodIndex:   p.index,
    billOn:        p.billOn,
    periodStart:   p.periodStart,
    periodEnd:     p.periodEnd,
    taxableAmount: p.amount,
  }));
}

/**
 * Why this subscription must NOT be billed by instalment right now — or null when
 * it may be.
 *
 * ─── THE TERM MAY ALREADY HAVE BEEN COLLECTED ───────────────────────────────
 * Today's sell path charges the customer the WHOLE term when they accept a quote:
 * /api/public/quote/[id]/pay takes quote.amount, and record_payment closes the quote
 * as received. Raising instalment invoices on top of that bills a customer a second
 * time for money they have already paid.
 *
 * So a term that has been collected is skipped, and the reason is returned rather
 * than the subscription being quietly dropped from the run. A cron that reports
 * "0 invoices raised" is indistinguishable from a broken one, which is how the
 * renewal engine's own dry-run mode came to exist.
 *
 * ─── R-375: COLLECTED IS NOT THE SAME AS INVOICED ────────────────────────────
 * The skip above used to fire on "collected" alone. But a split-billed quote paid IN FULL
 * at the desk can never get a whole-term GST invoice — the invoices trigger
 * (reject_full_term_invoice_when_split_billed, 20260817110200) refuses generate_invoice for
 * it — so skipping its instalments too left real, paid supply with NO tax invoice anywhere.
 *
 * The double-billing fear does not apply to raising the instalments of a collected term:
 * raise_subscription_billing credits what was received against the quote (minus what earlier
 * instalments already absorbed — 20260817120100, kept in 20261007130000), so each period's
 * invoice is issued already PAID from the advance. One GST invoice per period, no new demand.
 *
 * So the only collected term that must still be skipped is one that ALREADY has a whole-term
 * invoice (raised before the guard existed, or before the cycle was changed): instalments on
 * top of that would be a second tax invoice for the same supply.
 */
export interface InstalmentSkip {
  code:   "not_split_billed" | "term_already_invoiced" | "no_schedule";
  reason: string;
}

export function instalmentSkip(args: {
  cycle:        BillingCycle | null | undefined;
  /** ₹ already received against the quote this subscription was sold on. */
  quotePaid:    number | null | undefined;
  /** ₹ the quote was for, GST-inclusive. */
  quoteAmount:  number | null | undefined;
  /**
   * The quote already has a whole-term tax invoice (quotes.invoice_id, or a non-void invoice
   * row carrying its quote_id). Required, not optional: the caller has to look.
   */
  quoteInvoiced: boolean;
  scheduleSize: number;
}): InstalmentSkip | null {
  if (!isSplitBilled(args.cycle)) {
    return { code: "not_split_billed", reason: "Billed yearly — invoiced from the quote, not per period." };
  }
  if (args.scheduleSize === 0) {
    return { code: "no_schedule", reason: "No term dates or no MRR, so there is nothing to lay instalments against." };
  }

  const paid   = args.quotePaid ?? 0;
  const amount = args.quoteAmount ?? 0;
  /* A whole-term invoice already exists → instalments would be a second tax invoice for the
     same supply. Collected-but-NOT-invoiced is billed (R-375): each instalment is raised
     with the collected money applied as credit, so it is issued paid, not demanded again. */
  if (args.quoteInvoiced) {
    const collected = amount > 0 && paid >= amount;
    return {
      code: "term_already_invoiced",
      reason: collected
        ? `The whole term was collected (₹${paid.toLocaleString("en-IN")} of ₹${amount.toLocaleString("en-IN")}) and already has a whole-term tax invoice. Instalment invoices would invoice it twice.`
        : "The quote already has a whole-term tax invoice. Instalment invoices would invoice the same supply twice.",
    };
  }
  return null;
}

/**
 * What a split-billed QUOTE collects today, before any subscription exists.
 *
 * ─── WHY THE QUOTE NEEDS ITS OWN VERSION OF THIS ────────────────────────────
 * plannedInstalments() works off a subscription. At the moment a customer clicks
 * "Pay", there is no subscription — record_payment creates it from the payment. So
 * the amount to charge has to come from the quote, and it has to come out of the
 * SAME schedule engine, or a customer is charged one figure and invoiced another.
 *
 * ─── THE TAXABLE AMOUNT IS SPLIT, NOT THE GROSS ─────────────────────────────
 * Deliberately the same way round as the ledger, which stores taxable and grosses it
 * when the invoice is raised. Splitting the gross instead would charge a figure the
 * instalment invoice could not reproduce from its own taxable value, and a tax
 * invoice that cannot reproduce what was charged is the one an auditor picks up.
 *
 * ─── IT WILL NOT MATCH THE INVOICE TO THE LAST RUPEE, AND THAT IS KNOWN ─────
 * record_payment derives mrr as round(line_amount / 12) (baseline.sql:4580), so a
 * term that does not divide by 12 already loses a rupee or two between the quote and
 * the subscription — before any of this existed. The instalment invoice is raised
 * from the SUBSCRIPTION, so it can differ from what was charged here by that much.
 * raise_subscription_billing credits what was actually received rather than assuming
 * the two agree, which is why the difference is harmless rather than a stuck balance.
 */
export interface QuoteInstalments {
  cycle: BillingCycle;
  /** How many invoices the term is split into. */
  count: number;
  /** ₹ ex-GST for the first period. */
  firstTaxable: number;
  /** ₹ INCLUDING GST — what the customer pays today. */
  firstGross: number;
  /** ₹ INCLUDING GST for the whole term — what the quote totals. */
  termGross: number;
  /** R-527: Σ of every instalment's own gross — what the term's invoices add up to. */
  instalmentsGross: number;
}

/**
 * Any valid date. buildBillingSchedule divides the term into equal parts and carries
 * the remainder into the last one — the AMOUNTS do not depend on when the term
 * starts, only the dates do, and this function returns no dates. Taking a start date
 * as a parameter would imply otherwise and invite a caller to hunt for one that its
 * quote shape does not even carry.
 */
const AMOUNT_ONLY_ANCHOR = "2000-01-01";

export function quoteInstalments(args: {
  cycle: BillingCycle | null | undefined;
  /** ₹ ex-GST for the term (quotes.subtotal, net of discount). */
  termTaxable: number;
  /** ₹ incl GST for the term (quotes.amount). */
  termGross: number;
  taxRate: number;
  /** Whole months in the term. Committed sales are 12 — see record_payment. */
  termMonths?: number;
  /**
   * Pehli line ka `commitment`. `'monthly'` = FLEX — aur flex me quote ke
   * stored aankde pehle se PER-MONTH hain (wahi seema jo quote-body.ts aur
   * record_payment dono maante hain: `commitment === 'monthly'` par
   * line-figures mahine ke hote hain, saal ke nahi). Unhe 12 par baantna
   * 1 Sep 2026 ko naapi gayi 12× UNDER-charge thi: ₹5,753/month ke flex
   * quote par pay-button ₹479 maang raha tha. Flex me baantne ko kuch hai
   * hi nahi — stored amount hi har mahine ki vasooli hai — isliye null.
   */
  lineCommitment?: string | null;
}): QuoteInstalments | null {
  const { cycle, termTaxable, termGross, taxRate } = args;
  if (args.lineCommitment === "monthly") return null;
  if (!isSplitBilled(cycle)) return null;
  if (!Number.isFinite(termTaxable) || termTaxable <= 0) return null;
  if (!Number.isFinite(termGross)   || termGross   <= 0) return null;

  const periods = buildBillingSchedule({
    startDate:  AMOUNT_ONLY_ANCHOR,
    termMonths: Math.max(1, args.termMonths ?? 12),
    cycle:      cycle as BillingCycle,
    termAmount: termTaxable,
  });
  if (periods.length <= 1) return null;   // nothing was actually split

  return {
    cycle:        cycle as BillingCycle,
    count:        periods.length,
    firstTaxable: periods[0].amount,
    firstGross:   instalmentGross(periods[0].amount, taxRate),
    termGross,
    instalmentsGross: periods.reduce((s, p) => s + instalmentGross(p.amount, taxRate), 0),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   R-527 — ONE ROUNDING RULE FOR AN INSTALMENT, EVERYWHERE
   ────────────────────────────────────────────────────────────────────────────
   Measured 9 Oct 2026 on Q-FBB9-27-0020 (Starter × 8, annual commitment, billed
   quarterly, ₹25,920 ex-GST a year):
     editor            ₹30,586 ÷ 4 = ₹7,646.5 → ₹7,647 / qtr
     customer page     ₹6,480 + round(₹1,166.40) = ₹7,646 / qtr
     instalment invoice (raise_subscription_billing) ₹6,480 + round(6,480 × 18%) = ₹7,646
   Three screens, two figures for one bill.

   GST is charged on the value of EACH supply — each instalment's own tax invoice — and
   rounded to the nearest rupee: tax = round(instalment taxable × rate / 100). So the
   per-instalment figure is the INVOICE's figure, and the year's GST divided by four is
   not a number any document will ever carry. Every screen that prints a per-instalment
   amount (editor, PDF, preview, customer page, payment dialog) reads it from here; the
   SQL twin is public.quote_split_due() (migration 20261009235800).

   The year of instalments can therefore differ from quotes.amount by a rupee or two
   (₹30,584 vs ₹30,586 here). quotes.amount is not rewritten: it is the accepted
   quotation, and quoteAmountGap() reads it. What is DUE is always the sum of the
   instalments that have fallen due — never quotes.amount.
   ════════════════════════════════════════════════════════════════════════════ */

/** ₹ incl GST for one instalment — the figure its tax invoice carries. */
export function instalmentGross(taxable: number, taxRatePct: number): number {
  return grossAmount(taxable, taxRatePct);
}

export interface InstalmentLine {
  index:       number;
  billOn:      string;
  periodStart: string;
  /** Exclusive. */
  periodEnd:   string;
  taxable:     number;
  tax:         number;
  gross:       number;
}

export interface QuoteInstalmentPlan {
  cycle: BillingCycle;
  count: number;
  lines: InstalmentLine[];
  /** Σ gross of every instalment — what the term actually invoices. */
  instalmentsGross: number;
}

/**
 * The dated instalments of a split-billed quote from `termStart` (the day the
 * subscription starts — today for a quote not paid yet). Same arguments and the same
 * nulls as quoteInstalments(): a flex line or a yearly quote has no plan.
 */
export function quoteInstalmentPlan(args: Parameters<typeof quoteInstalments>[0] & {
  termStart: string;
}): QuoteInstalmentPlan | null {
  const summary = quoteInstalments(args);
  if (!summary) return null;
  const periods = buildBillingSchedule({
    startDate:  args.termStart.slice(0, 10),
    termMonths: Math.max(1, args.termMonths ?? 12),
    cycle:      summary.cycle,
    termAmount: args.termTaxable,
  });
  const lines = periods.map((p) => {
    const gross = instalmentGross(p.amount, args.taxRate);
    return {
      index: p.index, billOn: p.billOn, periodStart: p.periodStart, periodEnd: p.periodEnd,
      taxable: p.amount, tax: gross - p.amount, gross,
    };
  });
  return {
    cycle: summary.cycle,
    count: lines.length,
    lines,
    instalmentsGross: lines.reduce((s, l) => s + l.gross, 0),
  };
}

export interface SplitDue {
  /** Instalments whose bill date has arrived (the first is due on the start day). */
  dueCount:    number;
  /** ₹ incl GST of those instalments. */
  dueGross:    number;
  /** ₹ owed today = dueGross − received, never negative. */
  outstanding: number;
  /** The first instalment the money received does not cover yet. */
  next:        InstalmentLine | null;
  /** How many instalments the money received covers in full. */
  paidCount:   number;
}

/**
 * What a split-billed quote owes TODAY. Only instalments that have fallen due count —
 * a quarterly year is not "₹22,940 outstanding" on the day Q1 is paid.
 */
export function splitDue(plan: QuoteInstalmentPlan, args: { todayISO: string; received: number }): SplitDue {
  const today = args.todayISO.slice(0, 10);
  const due = plan.lines.filter((l, i) => i === 0 || l.billOn <= today);
  const dueGross = due.reduce((s, l) => s + l.gross, 0);
  const received = Math.max(0, Math.round(args.received || 0));

  let left = received;
  let paidCount = 0;
  for (const l of plan.lines) {
    if (left >= l.gross) { left -= l.gross; paidCount += 1; } else break;
  }
  return {
    dueCount:    due.length,
    dueGross,
    outstanding: Math.max(0, dueGross - received),
    next:        plan.lines[paidCount] ?? null,
    paidCount,
  };
}

/** The quote columns every split-billing screen reads. */
export interface SplitQuoteFields {
  subtotal:       number | null;
  discount_pct:   number | null;
  tax_rate:       number | null;
  amount:         number | null;
  billing_cycle?: string | null;
  line_items?:    unknown;
}

/** The first line's commitment, read defensively off a stored line_items jsonb. */
export function firstLineCommitment(lineItems: unknown): string | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const c = (lineItems[0] as { commitment?: unknown } | null)?.commitment;
  return typeof c === "string" ? c : null;
}

/** quoteInstalmentPlan() straight from a quote row. Null = not split-billed. */
export function planForQuote(q: SplitQuoteFields, termStart: string): QuoteInstalmentPlan | null {
  const subtotal = Math.round(q.subtotal ?? 0);
  return quoteInstalmentPlan({
    cycle:          (q.billing_cycle ?? null) as BillingCycle | null,
    termTaxable:    subtotal - Math.round((subtotal * (q.discount_pct ?? 0)) / 100),
    termGross:      q.amount ?? 0,
    taxRate:        q.tax_rate ?? 18,
    lineCommitment: firstLineCommitment(q.line_items),
    termStart,
  });
}

/**
 * Which of these instalments are due to be invoiced today.
 *
 * `<=` and not `===`: a cron that missed a day must catch up rather than skip the
 * period forever. Raising it is safe because raise_subscription_billing is
 * idempotent — a period already invoiced returns its existing invoice.
 */
export function instalmentsDue<T extends { billOn: string; invoiceId: string | null }>(
  rows: readonly T[],
  todayISO: string,
): T[] {
  return rows.filter((r) => r.invoiceId == null && r.billOn <= todayISO);
}
