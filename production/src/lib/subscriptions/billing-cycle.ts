/**
 * R-1696 (Pardeep, 20 Oct 2026): "billing cycle ke hisaab bhi filter hona chahiye".
 *
 * Every row on /subscriptions already says its cycle ("Annual · billed yearly · ₹1,39,500").
 * The filter must put a row under the SAME cycle its label names, so both read
 * subscriptionCycle() — the row takes `.label` (and `.term` for the amount), the filter
 * takes `.kind`.
 *
 * R-1774 (Pardeep, 23 Oct 2026): "cycle wali patti me kya sab logical hai, khaas kar
 * quarterly". The chips now use the words the vendors sell under:
 *   Google Workspace — Annual or Flexible (monthly)
 *   Microsoft        — Monthly, Annual or 3-year
 * Nobody sells a whole TERM of 3 or 6 months. A row whose term is a quarter or a half-year
 * is therefore a data problem, not a cycle choice — it goes under a yellow "Check term"
 * chip and the row points at Correct details. Nothing here changes the data.
 *
 * What separates an ANNUAL term billed in parts (billing_cycle monthly / quarterly /
 * half-yearly, term_months 12 — R-826/R-807/R-808) from a plan whose whole term is a month
 * or a quarter is term_months: record_payment writes 1 for a monthly (flex) plan and 12 for
 * an annual one, and the billing schedule reads a missing term_months as 12 — so does this.
 * For a 'yearly' row the start↔renewal span is the witness, as before (rowTerm).
 */
import type { BillingCycle } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { rowTerm, type Term } from "./renewal-display";

export type CycleKind = "annual" | "annual_split" | "three_year" | "monthly" | "check_term" | "none";
export type CycleFilter = "all" | CycleKind;

/** Every chip value, in the order the chips show. */
export const CYCLE_FILTERS: readonly CycleFilter[] = [
  "all", "annual", "annual_split", "three_year", "monthly", "check_term", "none",
] as const;

/** R-1696 links used ?cycle=quarterly / half_yearly. They still open — on Check term. */
export type LegacyCycle = "quarterly" | "half_yearly";
export type CycleUrlValue = CycleFilter | LegacyCycle;
export const CYCLE_URL_VALUES: readonly CycleUrlValue[] = [...CYCLE_FILTERS, "quarterly", "half_yearly"];

export function cycleFromUrl(v: CycleUrlValue): CycleFilter {
  return v === "quarterly" || v === "half_yearly" ? "check_term" : v;
}

export const CYCLE_LABEL: Record<CycleFilter, string> = {
  all:          "All cycles",
  annual:       "Annual · paid yearly",
  annual_split: "Annual · paid monthly/quarterly",
  three_year:   "3 years",
  monthly:      "Flexible (monthly)",
  check_term:   "Check term",
  none:         "No term",
};

/** What each chip means, for its tooltip. annual_split adds its own breakdown. */
export const CYCLE_HINT: Record<CycleFilter, string> = {
  all:          "Every billing cycle",
  annual:       "Annual term, billed once a year",
  annual_split: "Annual term, billed in parts",
  three_year:   "3-year term (Microsoft triennial)",
  monthly:      "Month-to-month plan, can be cancelled any month (Google Flexible, Microsoft monthly)",
  check_term:   "Term saved as 3 or 6 months — Google and Microsoft sell annual or monthly terms only. Open the subscription and use Correct details.",
  none:         "No start or renewal date to tell the term",
};

/** The row's warning, word for word (R-1774). */
export const CHECK_TERM_ROW = "Check term — vendors sell annual or monthly";

export interface CycleSub {
  billing_cycle: BillingCycle | string | null | undefined;
  term_months:   number | null | undefined;
  start_date:    string | null | undefined;
  renewal_date:  string | null | undefined;
}

export interface SubCycle {
  kind: CycleKind;
  /** What ONE invoice covers — exactly rowTerm(). Used for the amount on the row. */
  term: Term | null;
  /** The row's words, the same as its chip's ("Annual · billed quarterly"). Null = no badge. */
  label: string | null;
}

/** "monthly" / "quarterly" / "half-yearly" / "yearly" — how often one invoice goes out. */
function billedWord(months: number): string {
  if (months <= 1) return "monthly";
  if (months <= 3) return "quarterly";
  if (months <= 6) return "half-yearly";
  return "yearly";
}

/** The one rule for a row's billing cycle — its label and its filter both come from here. */
export function subscriptionCycle(sub: CycleSub): SubCycle {
  const term = rowTerm(sub.billing_cycle, sub.start_date, sub.renewal_date);
  const tm = sub.term_months;

  if (tm != null && tm >= 36) {
    return { kind: "three_year", term, label: term ? `3 years · paid ${billedWord(term.months)}` : "3 years" };
  }

  if (isSplitBilled(sub.billing_cycle as BillingCycle)) {
    const len = tm ?? 12;
    if (len >= 12) return { kind: "annual_split", term, label: `Annual · paid ${billedWord(term?.months ?? 12)}` };
    if (len <= 1)  return { kind: "monthly", term, label: CYCLE_LABEL.monthly };
    return { kind: "check_term", term, label: CHECK_TERM_ROW };
  }

  if (!term) return { kind: "none", term, label: null };
  if (term.months >= 12) return { kind: "annual", term, label: CYCLE_LABEL.annual };
  if (term.months <= 1)  return { kind: "monthly", term, label: CYCLE_LABEL.monthly };
  return { kind: "check_term", term, label: CHECK_TERM_ROW };
}

/** The row's tooltip: "Annual · billed yearly — ₹1,39,500 per invoice". */
export function cycleInvoiceTitle(c: SubCycle, amount: string): string {
  if (c.kind === "check_term") {
    return `Saved as a ${c.term?.months ?? "?"}-month term — ${amount} per invoice. `
      + "Google and Microsoft sell annual or monthly terms; fix it with Correct details.";
  }
  return `${c.label ?? "Term"} — ${amount} per invoice`;
}

export function matchesCycle(sub: CycleSub, filter: CycleFilter): boolean {
  return filter === "all" || subscriptionCycle(sub).kind === filter;
}

export interface CycleOption {
  value: CycleFilter;
  label: string;
  hint: string;
  count: number;
  /** "warning" = a chip that lists rows to fix, not a cycle to choose (Check term). */
  tone?: "warning";
}

/**
 * The chips to show for `rows`: All, then only the cycles present, each with its count.
 * The selected cycle stays even at 0 — a chip that vanishes while it is on leaves the
 * operator with an empty list and nothing to switch off.
 */
export function cycleOptions(rows: readonly CycleSub[], selected: CycleFilter): CycleOption[] {
  const counts = new Map<CycleKind, number>();
  const parts: Record<string, number> = { monthly: 0, quarterly: 0, "half-yearly": 0 };
  for (const r of rows) {
    const c = subscriptionCycle(r);
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    if (c.kind === "annual_split") {
      const w = billedWord(c.term?.months ?? 12);
      if (w in parts) parts[w]++;
    }
  }
  const breakdown = Object.entries(parts).filter(([, n]) => n > 0).map(([w, n]) => `${n} ${w}`).join(", ");
  return CYCLE_FILTERS
    .filter((v) => v === "all" || (counts.get(v) ?? 0) > 0 || v === selected)
    .map((v) => ({
      value: v,
      label: CYCLE_LABEL[v],
      hint: v === "annual_split" && breakdown ? `${CYCLE_HINT[v]}: ${breakdown}` : CYCLE_HINT[v],
      count: v === "all" ? rows.length : counts.get(v) ?? 0,
      ...(v === "check_term" ? { tone: "warning" as const } : {}),
    }));
}
