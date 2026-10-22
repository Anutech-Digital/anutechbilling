"use client";

import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

// ============================================================
// LineAdjustControls — what the CUSTOMER may change on the public quote page.
//
// Off by default, and that default is the point: a quote where the buyer can edit
// anything is an order form the seller has not seen. The reseller opts each line in,
// and the server re-checks these flags before it prices anything, because the public
// page has no session. See lib/quotes/configure.ts.
//
// R-1674 (owner, 19 Oct 2026): the per-line "Customer can ☐ change seats" option is gone
// from the builder — the owner does not want buyers setting their own seat count on a
// quote; a seat change goes back to the reseller. Quotes ALREADY SENT with
// `seats_adjustable` keep working on the public page (configure.ts is unchanged and their
// data is not stripped); a DUPLICATE of such a quote drops the flag (see dropSeatsAdjustable).
//
// R-1754 (owner, 22 Oct 2026): the "Customer can ☐ add / remove" box no longer sits on
// every line. Most lines are required — the box was noise, and a stray tick let a buyer drop
// a required line and pay less. "Make optional for customer" now lives in the line's ⋯ menu
// (LineMoreMenu). A line that IS optional shows a chip saying so, with its "Starts ticked /
// unticked" choice next to it. The data (optional, included_by_default) and the public Accept
// page are unchanged, so a quote that already has optional lines opens with the chip showing.
// ============================================================

/** Patch that makes a line optional (starts unticked, the safe default) or required again. */
export function optionalPatch(makeOptional: boolean, line: QuoteLineItem): Partial<QuoteLineItem> {
  return makeOptional
    ? { optional: true, included_by_default: line.included_by_default ?? false }
    // Clearing "optional" clears the default too — it only means something on optional lines.
    : { optional: undefined, included_by_default: undefined };
}

/** The chip on an optional line. Renders nothing on a required line. */
export function LineAdjustControls({ line, onChange }: {
  line: QuoteLineItem;
  onChange: (patch: Partial<QuoteLineItem>) => void;
}) {
  if (!line.optional) return null;
  const ticked = !!line.included_by_default;
  const seg = (on: boolean) => cn(
    "px-1.5 py-0.5 text-2xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber",
    on ? "bg-amber-soft text-amber-ink" : "bg-paper text-ink-3 hover:bg-paper-2",
  );
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
      <span className="inline-flex items-center rounded-full border border-amber/40 bg-amber-soft px-2 py-0.5 font-semibold text-amber-ink">
        Optional · customer can remove
      </span>
      <span className="inline-flex items-center gap-1 text-ink-3">
        <span id={`starts-${line.id}`}>Starts</span>
        <span role="group" aria-labelledby={`starts-${line.id}`} className="inline-flex overflow-hidden rounded border border-hairline">
          <button type="button" aria-pressed={ticked} className={seg(ticked)}
            onClick={() => onChange({ included_by_default: true })}>Ticked</button>
          <button type="button" aria-pressed={!ticked} className={cn(seg(!ticked), "border-l border-hairline")}
            onClick={() => onChange({ included_by_default: undefined })}>Unticked</button>
        </span>
      </span>
    </div>
  );
}

/** The line's ⋯ menu: where a line is made optional for the customer, or required again. */
export function LineMoreMenu({ line, onChange }: {
  line: QuoteLineItem;
  onChange: (patch: Partial<QuoteLineItem>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more_h" aria-label={`More options for ${line.name}`} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        {line.optional ? (
          <DropdownMenuItem onSelect={() => onChange(optionalPatch(false, line))}>
            Make required
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onChange(optionalPatch(true, line))}>
            Make optional for customer
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * R-1674: a line copied into a NEW quote (Duplicate / Revise & resend) must not carry the
 * customer-may-change-seats flag — the builder can no longer show or untick it. In-place
 * Edit of an existing quote keeps its data as it is.
 */
export function dropSeatsAdjustable(line: QuoteLineItem): QuoteLineItem {
  const { seats_adjustable: _sa, min_seats: _min, max_seats: _max, ...rest } = line;
  return rest;
}
