/**
 * R-381 — one quote, one billing term.
 *
 * A flex-monthly line stores its rate per seat per MONTH; every other commitment
 * (`annual_*`) stores it per seat per YEAR (see commitment-rate.ts). A quote that
 * carries both adds a month to a year in its subtotal, and the PDF, e-mail and
 * builder all read the term from the FIRST line — so the customer saw one figure
 * labelled with the wrong unit. Rather than teach every surface to split totals,
 * a quote is limited to one term: monthly lines go on their own quote.
 *
 * An empty commitment counts as annual (the column's default, `annual_yearly`).
 * The database enforces the same rule for user-made quotes
 * (migration 20261007160000_quote_one_billing_term.sql).
 */
import type { LineCommitment } from "@/lib/supabase/database.types";

export const ONE_TERM_MESSAGE = "One quote = one billing term. Put monthly items on a separate quote.";

export type BillingTerm = "monthly" | "annual";

/** The billing term a line belongs to. Missing commitment = annual. */
export function lineTerm(commitment: LineCommitment | null | undefined): BillingTerm {
  return commitment === "monthly" ? "monthly" : "annual";
}

/** True when the lines hold at least one monthly AND at least one annual line. */
export function isMixedTerm(lines: ReadonlyArray<{ commitment?: LineCommitment | null }>): boolean {
  let monthly = false;
  let annual = false;
  for (const l of lines) {
    if (lineTerm(l.commitment) === "monthly") monthly = true;
    else annual = true;
    if (monthly && annual) return true;
  }
  return false;
}
