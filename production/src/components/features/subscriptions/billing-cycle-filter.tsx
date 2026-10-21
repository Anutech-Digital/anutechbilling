"use client";
/**
 * R-1696 — the "Billing cycle" chips on /subscriptions, next to the vendor chips and in
 * the same pill style. Options and counts come from cycleOptions() (lib/subscriptions/
 * billing-cycle.ts), which reads the same rule as each row's "Annual · ₹…" label.
 */
import { cn } from "@/lib/utils";
import type { CycleFilter, CycleOption } from "@/lib/subscriptions/billing-cycle";

export interface BillingCycleFilterProps {
  options: CycleOption[];
  value: CycleFilter;
  onChange: (next: CycleFilter) => void;
}

export function BillingCycleFilter({ options, value, onChange }: BillingCycleFilterProps) {
  /* All + one cycle is not a choice. Kept while a cycle is on, so it can be switched off. */
  if (options.length < 3 && value === "all") return null;
  return (
    <div role="group" aria-label="Billing cycle" className="inline-flex flex-wrap gap-1 bg-paper-2 rounded-md p-0.5">
      {options.map((opt) => {
        const on = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            title={opt.hint}
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer inline-flex items-center gap-1.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              on ? "bg-paper text-ink shadow-xs font-semibold" : "text-ink-3 hover:text-ink",
            )}
          >
            {opt.label}
            <span className="tabular-nums text-ink-3 font-normal">{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default BillingCycleFilter;
