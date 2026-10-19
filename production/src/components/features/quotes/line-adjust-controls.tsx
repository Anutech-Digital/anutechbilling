"use client";

import type { QuoteLineItem } from "@/lib/supabase/database.types";

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
// quote; a seat change goes back to the reseller. Only "add / remove this" (and its
// "ticked to start") stays. Quotes ALREADY SENT with `seats_adjustable` keep working on
// the public page (configure.ts is unchanged and their data is not stripped); a
// DUPLICATE of such a quote drops the flag (see dropSeatsAdjustable) so no new quote
// gets it from the builder.
// ============================================================
export function LineAdjustControls({ line, onChange }: {
  line: QuoteLineItem;
  onChange: (patch: Partial<QuoteLineItem>) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Customer can</span>
      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={!!line.optional}
          onChange={(e) => onChange({
            optional: e.target.checked || undefined,
            // Un-ticking "optional" must clear the default too, or a line that is no
            // longer optional keeps a flag that only means something for optional lines.
            included_by_default: e.target.checked ? (line.included_by_default ?? false) : undefined,
          })}
          className="h-3.5 w-3.5 accent-amber"
        />
        <span className="text-ink-2">add / remove this</span>
      </label>
      {line.optional && (
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={!!line.included_by_default}
            onChange={(e) => onChange({ included_by_default: e.target.checked || undefined })}
            className="h-3.5 w-3.5 accent-amber"
          />
          <span className="text-ink-3">ticked to start</span>
        </label>
      )}
    </div>
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
