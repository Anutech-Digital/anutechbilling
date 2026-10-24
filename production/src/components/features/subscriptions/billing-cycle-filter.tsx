"use client";
/**
 * R-1696 — the "Billing cycle" chips on /subscriptions, next to the vendor chips and in
 * the same pill style. Options and counts come from cycleOptions() (lib/subscriptions/
 * billing-cycle.ts), which reads the same rule as each row's "Annual · billed yearly · ₹…"
 * label (R-1774).
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
        /* R-1774: "Check term" lists rows to fix, not a cycle to choose — yellow, with a dot. */
        const warn = opt.tone === "warning";
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            title={opt.hint}
            data-tone={warn ? "warning" : undefined}
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer inline-flex items-center gap-1.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              warn
                ? cn("bg-amber-soft text-amber-ink hover:text-amber-ink", on && "shadow-xs font-semibold ring-1 ring-amber")
                : on ? "bg-paper text-ink shadow-xs font-semibold" : "text-ink-3 hover:text-ink",
            )}
          >
            {warn && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-amber" />}
            {opt.label}
            <span className={cn("tabular-nums font-normal", warn ? "text-amber-ink" : "text-ink-3")}>{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default BillingCycleFilter;
