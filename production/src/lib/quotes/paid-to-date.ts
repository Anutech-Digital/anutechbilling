/**
 * R-2055 (28 Oct 2026, Pardeep) — the SALE quote of a subscription billed in parts, once the
 * first part is paid, is "Paid to date", not "Partly paid".
 *
 * Pardeep's localhost run: Annual commitment, billed quarterly, ₹38,232 for the year; the
 * first part ₹9,558 paid today. The quote page said "Partly paid", "₹28,674 still due" and
 * "Remaining ₹28,674" next to "Instalments due so far are paid" — nothing was due. Since
 * R-2044 every later part is its own PAYMENT REQUEST (quotes.subscription_billing_id) raised on
 * its date, and its tax invoice is raised when it is paid. So the rest of the year is money
 * COMMITTED, not money owed on this quote — the Commitment due list (R-2046) is where an unpaid
 * part shows up, from its date.
 *
 * One rule for the quote page, the Quotes list tab / badge / cash note and the Partial tile.
 */
import { planForQuote, type QuoteInstalmentPlan, type SplitQuoteFields, type InstalmentLine } from "@/lib/billing/instalments";
import { isPartRequest } from "@/lib/billing/part-requests";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

/** The post-R-2044 sentence, wherever a split-billed quote explains its later parts. */
export const PARTS_WORDING = "each part gets a payment request on its date; its tax invoice is raised when paid";

export interface PaidToDate {
  /** ₹ received on this sale quote. */
  received: number;
  /** ₹ still committed for the rest of the term (the parts not yet paid). */
  committed: number;
  /** How many parts are left. */
  partsLeft: number;
  /** The next part (its bill date is ISO yyyy-mm-dd). */
  next: InstalmentLine;
  /** Parts in the term. */
  count: number;
}

/** From a plan already built (the quote page builds it from the subscription's start). */
export function paidToDateOfPlan(plan: QuoteInstalmentPlan | null | undefined, received: number): PaidToDate | null {
  if (!plan || plan.lines.length < 2) return null;
  const got = Math.max(0, Math.round(received || 0));
  let left = got;
  let paidCount = 0;
  for (const l of plan.lines) {
    if (left >= l.gross) { left -= l.gross; paidCount += 1; } else break;
  }
  /* Nothing paid yet → the first part is due (ordinary "Record payment"); all paid → Paid. */
  if (paidCount === 0 || paidCount >= plan.lines.length) return null;
  const rest = plan.lines.slice(paidCount);
  const committed = Math.max(0, rest.reduce((s, l) => s + l.gross, 0) - left);
  return { received: got, committed, partsLeft: rest.length, next: rest[0], count: plan.lines.length };
}

export interface PaidToDateQuote {
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
  amount?: number | null;
  billing_cycle?: string | null;
  line_items?: unknown;
  status: string;
  payment_status?: string | null;
  payment_amount?: number | null;
  invoice_id?: string | null;
  subscription_billing_id?: string | null;
}

/**
 * From the quote row alone (the Quotes list has no subscription start). The amounts of the
 * parts do not depend on the start date (quarterly-billing.test "a plan from a later start keeps
 * the same amounts"), so `termStart` only matters for `next.billOn`.
 */
export function paidToDateOf(q: PaidToDateQuote, termStart: string = istToday()): PaidToDate | null {
  if (isPartRequest(q)) return null;
  if (q.invoice_id || q.payment_status === "invoiced") return null;
  if (q.status === "rejected" || q.status === "expired") return null;
  const received = Math.max(0, Number(q.payment_amount ?? 0) || 0);
  if (received <= 0 || !q.billing_cycle || q.billing_cycle === "yearly") return null;
  const fields: SplitQuoteFields = {
    subtotal: q.subtotal ?? null, discount_pct: q.discount_pct ?? null, tax_rate: q.tax_rate ?? null,
    amount: q.amount ?? null, billing_cycle: q.billing_cycle, line_items: q.line_items,
  };
  return paidToDateOfPlan(planForQuote(fields, termStart.slice(0, 10)), received);
}

/** Badge / list word — "Paid to date". */
export const PAID_TO_DATE_LABEL = "Paid to date";

/** "Paid to date — next part ₹9,558 on 28 Jan 2027" (date already formatted by the caller). */
export function paidToDateLine(p: Pick<PaidToDate, "next">, billOnShown: string): string {
  return `${PAID_TO_DATE_LABEL} — next part ${rupee(p.next.gross)} on ${billOnShown}`;
}

/** "Committed for the rest of the year ₹28,674 (3 parts)" — payment history, instead of "Remaining". */
export function committedLine(p: Pick<PaidToDate, "committed" | "partsLeft">): string {
  return `Committed for the rest of the year ${rupee(p.committed)} (${p.partsLeft} part${p.partsLeft === 1 ? "" : "s"})`;
}
