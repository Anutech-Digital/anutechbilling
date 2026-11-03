/**
 * R-2422 (Pardeep, 3 Nov — staging Renewals): "₹78,000/yr" did not say HOW it is paid. The
 * renewal amount cell now carries the commitment + payment frequency in the Subscriptions list's
 * own words — subscriptionCycle().label ("Annual · paid yearly", "Annual · paid quarterly",
 * "Flexible (monthly)") — and, for an annual term billed in parts, what ONE part is, worked out
 * exactly like the list's badge (termValue with the row's own term_amount; "about" when it is
 * rebuilt from a rounded monthly). Pure — tested in frequency-r2422.test.ts.
 */
import { rupee } from "@/lib/utils";
import { subscriptionCycle, type CycleSub } from "@/lib/subscriptions/billing-cycle";
import { termValue, termValueLabel, storedAnnual } from "@/lib/subscriptions/renewal-display";

export interface FrequencySub extends CycleSub {
  mrr: number | null;
  term_amount?: number | null;
}

/** "Annual · paid quarterly · ₹19,500 each" / "Annual · paid yearly" / "Flexible (monthly)"; null = term unknown. */
export function renewalFrequency(sub: FrequencySub): string | null {
  const cyc = subscriptionCycle(sub);
  if (!cyc.label) return null;
  if (cyc.kind !== "annual_split" || !cyc.term) return cyc.label;
  const part = termValue(sub.mrr, cyc.term.months, null, storedAnnual(sub));
  return part.amount > 0 ? `${cyc.label} · ${termValueLabel(part, rupee)} each` : cyc.label;
}
