/**
 * R-2423 — the quote's type in one big word (quote-kind.ts decides it): the stamp next to the
 * quote number, and the same word as a small chip on the Quotes list and the invoice header.
 * Paid → green. Nothing known → nothing rendered.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { QuoteStamp } from "@/lib/quotes/quote-kind";

export function QuoteKindStamp({ stamp, className }: { stamp: QuoteStamp | null; className?: string }) {
  if (!stamp) return null;
  return (
    <span
      data-testid="quote-kind-stamp"
      className={cn(
        "inline-flex items-center rounded-md border-2 px-2.5 py-1 font-sans text-sm font-bold uppercase tracking-wide leading-none",
        stamp.paid
          ? "border-emerald text-emerald bg-emerald-soft"
          : "border-indigo-ink/40 text-indigo-ink bg-indigo-soft",
        className,
      )}
    >
      {stamp.text}
    </span>
  );
}

/** The small chip: "Renewal", "Add seats" … — the full stamp as its hover title. */
export function QuoteKindChip({ stamp, className }: { stamp: QuoteStamp | null; className?: string }) {
  if (!stamp) return null;
  const label = stamp.chip ?? stamp.partShort;
  if (!label) return null;
  return (
    <Badge kind={stamp.paid ? "success" : "info"} className={cn("font-sans text-3xs", className)} title={stamp.text}>
      {label}
    </Badge>
  );
}
