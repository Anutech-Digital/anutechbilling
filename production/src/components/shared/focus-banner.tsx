"use client";
/**
 * FocusBanner — "this list is narrowed to the records behind a number" (R-118).
 *
 * A tile click (or a link from the dashboard) sets a page's `?focus=`. The list then shows
 * exactly the rows the tile counted, and this line says so — otherwise a list of 3 under
 * a tab labelled "All" reads as a bug. Clear returns to the page's normal list.
 */
import { Button } from "@/components/ui/button";

/** R-2969: `total` — the money the narrowed rows add up to, already formatted (₹), shown after
 *  the count so the list can be checked against the number that opened it. */
export function FocusBanner({ label, count, total, onClear }: { label: string; count: number; total?: string; onClear: () => void }) {
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber/40 bg-amber-soft/30 px-3 py-2 text-sm"
    >
      <span className="text-ink">
        Showing: <strong className="font-semibold">{label}</strong>
        <span className="text-ink-3"> · {count}</span>
        {total && <span className="text-ink-3"> · <span className="tabular-nums text-ink">{total}</span></span>}
      </span>
      <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
    </div>
  );
}
