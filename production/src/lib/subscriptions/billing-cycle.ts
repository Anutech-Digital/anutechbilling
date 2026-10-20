/**
 * R-1696 (Pardeep, 20 Oct 2026): "billing cycle ke hisaab bhi filter hona chahiye".
 *
 * Every row on /subscriptions already says its cycle ("Annual · ₹1,39,500"), built by
 * rowTerm(). The filter must put a row under the SAME cycle its label names, so both read
 * subscriptionCycle() — the row takes `.term` for its label, the filter takes `.kind`.
 *
 * The one thing the label alone cannot tell apart is an ANNUAL term billed in parts
 * (billing_cycle monthly / quarterly / half-yearly, term_months 12 — R-826/R-807/R-808)
 * from a plan whose whole term is a month or a quarter. Both rows read "Quarterly", but
 * only the first is a year the customer has committed to. term_months is what separates
 * them: record_payment writes 1 for a monthly (flex) plan and 12 for an annual one, and
 * the billing schedule reads a missing term_months as 12 — so does this.
 */
import type { BillingCycle } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { rowTerm, type Term } from "./renewal-display";

export type CycleKind = "annual" | "annual_split" | "monthly" | "quarterly" | "half_yearly" | "none";
export type CycleFilter = "all" | CycleKind;

/** Every valid ?cycle= value, in the order the chips show. */
export const CYCLE_FILTERS: readonly CycleFilter[] = [
  "all", "annual", "annual_split", "monthly", "quarterly", "half_yearly", "none",
] as const;

export const CYCLE_LABEL: Record<CycleFilter, string> = {
  all:          "All cycles",
  annual:       "Annual",
  annual_split: "Annual · in parts",
  monthly:      "Monthly",
  quarterly:    "Quarterly",
  half_yearly:  "Half-yearly",
  none:         "No term",
};

/** What each chip means, for its tooltip. */
export const CYCLE_HINT: Record<CycleFilter, string> = {
  all:          "Every billing cycle",
  annual:       "Annual term, billed once a year",
  annual_split: "Annual term, billed monthly, quarterly or half-yearly",
  monthly:      "Monthly term",
  quarterly:    "Quarterly term",
  half_yearly:  "Half-yearly term",
  none:         "No start or renewal date to tell the term",
};

export interface CycleSub {
  billing_cycle: BillingCycle | string | null | undefined;
  term_months:   number | null | undefined;
  start_date:    string | null | undefined;
  renewal_date:  string | null | undefined;
}

export interface SubCycle {
  kind: CycleKind;
  /** What the row's label shows — exactly rowTerm(). */
  term: Term | null;
}

const KIND_BY_LABEL: Record<string, CycleKind> = {
  "Annual":      "annual",
  "Monthly":     "monthly",
  "Quarterly":   "quarterly",
  "Half-yearly": "half_yearly",
};

/** The one rule for a row's billing cycle — its label and its filter both come from here. */
export function subscriptionCycle(sub: CycleSub): SubCycle {
  const term = rowTerm(sub.billing_cycle, sub.start_date, sub.renewal_date);
  if (isSplitBilled(sub.billing_cycle as BillingCycle) && (sub.term_months ?? 12) >= 12) {
    return { kind: "annual_split", term };
  }
  if (!term) return { kind: "none", term };
  return { kind: KIND_BY_LABEL[term.label] ?? "none", term };
}

/** The row's tooltip: "Annual — ₹1,39,500 per invoice". */
export function cycleInvoiceTitle(c: SubCycle, amount: string): string {
  const base = `${c.term?.label ?? "Term"} — ${amount} per invoice`;
  return c.kind === "annual_split" ? `${base} (annual term, billed in parts)` : base;
}

export function matchesCycle(sub: CycleSub, filter: CycleFilter): boolean {
  return filter === "all" || subscriptionCycle(sub).kind === filter;
}

export interface CycleOption {
  value: CycleFilter;
  label: string;
  hint: string;
  count: number;
}

/**
 * The chips to show for `rows`: All, then only the cycles present, each with its count.
 * The selected cycle stays even at 0 — a chip that vanishes while it is on leaves the
 * operator with an empty list and nothing to switch off.
 */
export function cycleOptions(rows: readonly CycleSub[], selected: CycleFilter): CycleOption[] {
  const counts = new Map<CycleKind, number>();
  for (const r of rows) {
    const k = subscriptionCycle(r).kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return CYCLE_FILTERS
    .filter((v) => v === "all" || (counts.get(v) ?? 0) > 0 || v === selected)
    .map((v) => ({
      value: v,
      label: CYCLE_LABEL[v],
      hint: CYCLE_HINT[v],
      count: v === "all" ? rows.length : counts.get(v) ?? 0,
    }));
}
