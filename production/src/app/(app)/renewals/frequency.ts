/**
 * R-2422 (Pardeep, 3 Nov — staging Renewals): "₹78,000/yr" did not say HOW it is paid. The
 * renewal amount cell now carries the COMMITMENT + payment frequency in plain words, built on the
 * Subscriptions list's own rule (subscriptionCycle — so a row is never "annual" here and
 * "monthly" there): "Annual commitment · paid yearly", "Annual commitment · paid quarterly ·
 * ₹19,500 each", "Monthly commitment (flex)", "3-year commitment · paid yearly". For an annual
 * term billed in parts, ONE part is worked out exactly like the list's badge (termValue with the
 * row's own term_amount; "about" when it is rebuilt from a rounded monthly).
 * renewalCommitment() is the Commitment filter's value (All · Annual · Monthly).
 * Pure — tested in frequency-r2422.test.ts.
 */
import { rupee } from "@/lib/utils";
import { subscriptionCycle, type CycleSub } from "@/lib/subscriptions/billing-cycle";
import { termValue, termValueLabel, storedAnnual } from "@/lib/subscriptions/renewal-display";
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface FrequencySub extends CycleSub {
  mrr: number | null;
  term_amount?: number | null;
}

export type Commitment = "annual" | "monthly";

export const MONTHLY_COMMITMENT = "Monthly commitment (flex)";
/** A 1-month term NOT billed in parts renews by a renewal quote (R-2232) — monthly, but not flex. */
export const MONTHLY_COMMITMENT_QUOTED = "Monthly commitment";

/** "Annual · paid quarterly" → "Annual commitment · paid quarterly"; "3 years · …" → "3-year commitment · …". */
function commitmentWords(label: string): string {
  return label.replace(/^Annual\b/, "Annual commitment").replace(/^3 years\b/, "3-year commitment");
}

/** The words on the row; null = the term is unknown (no made-up words). */
export function renewalFrequency(sub: FrequencySub): string | null {
  const cyc = subscriptionCycle(sub);
  if (!cyc.label) return null;
  if (cyc.kind === "monthly") {
    return isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null) ? MONTHLY_COMMITMENT : MONTHLY_COMMITMENT_QUOTED;
  }
  if (cyc.kind === "check_term") return cyc.label;
  const words = commitmentWords(cyc.label);
  if (cyc.kind !== "annual_split" || !cyc.term) return words;
  const part = termValue(sub.mrr, cyc.term.months, null, storedAnnual(sub));
  return part.amount > 0 ? `${words} · ${termValueLabel(part, rupee)} each` : words;
}

/**
 * Monthly = a 1-month commitment (the list's "monthly" kind, or term_months 1); everything else is
 * Annual — 3-year too, and a row whose term cannot be told reads a missing term_months as 12, as
 * the billing schedule does. Never "unknown", so no row vanishes under both filter choices (a
 * "Check term" 3/6-month row sits under Annual, where its Correct details warning still shows).
 */
export function renewalCommitment(sub: FrequencySub): Commitment {
  return subscriptionCycle(sub).kind === "monthly" || (sub.term_months ?? 12) <= 1 ? "monthly" : "annual";
}
