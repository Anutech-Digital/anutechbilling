"use client";

import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/providers/confirm-provider";
import { SEAT_LINE_OPTIONAL_CONFIRM } from "@/lib/quotes/optional-line";

// ============================================================
// What the CUSTOMER may change on the public quote page.
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
// a required line and pay less. "Make optional for customer" lives in the line's ⋯ menu.
//
// R-1755 (owner, 22 Oct 2026): the big "Optional · customer can remove" chip and its
// "Starts Ticked | Unticked" switch took space in the description column. Now an optional line
// shows a one-word "Optional" tag right after its name (OptionalTag), and "Starts ticked for the
// customer" + "Make required" sit in the same ⋯ menu. Making a plan / seat line optional asks
// first (lib/quotes/optional-line.ts) — a second plan may be an optional extra, but the buyer
// can then drop those seats. Data (optional, included_by_default) and the Accept page unchanged.
// ============================================================

/** Patch that makes a line optional (starts unticked, the safe default) or required again. */
export function optionalPatch(makeOptional: boolean, line: QuoteLineItem): Partial<QuoteLineItem> {
  return makeOptional
    ? { optional: true, included_by_default: line.included_by_default ?? false }
    // Clearing "optional" clears the default too — it only means something on optional lines.
    : { optional: undefined, included_by_default: undefined };
}

/** The one-word tag after an optional line's name. Renders nothing on a required line. */
export function OptionalTag({ line }: { line: Pick<QuoteLineItem, "optional" | "included_by_default"> }) {
  if (!line.optional) return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded border border-amber/40 bg-amber-soft px-1 py-px align-middle text-3xs font-semibold text-amber-ink"
      title={line.included_by_default
        ? "The customer can remove this line. It starts ticked."
        : "The customer can add this line. It starts unticked."}
    >
      Optional
    </span>
  );
}

/**
 * The line's ⋯ menu: make the line optional for the customer (asking first on a plan / seat
 * line — `confirmOptional`), choose whether it starts ticked, or make it required again.
 */
export function LineMoreMenu({ line, onChange, confirmOptional = false }: {
  line: QuoteLineItem;
  onChange: (patch: Partial<QuoteLineItem>) => void;
  /** A plan / seat line (optionalNeedsConfirm): warn before the customer may drop it. */
  confirmOptional?: boolean;
}) {
  const confirm = useConfirm();
  const makeOptional = async () => {
    if (confirmOptional && !(await confirm({ ...SEAT_LINE_OPTIONAL_CONFIRM }))) return;
    onChange(optionalPatch(true, line));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more_h" aria-label={`More options for ${line.name}`} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem]">
        {line.optional ? (
          <>
            <DropdownMenuCheckboxItem
              checked={!!line.included_by_default}
              onCheckedChange={(on) => onChange({ included_by_default: on === true ? true : undefined })}
            >
              Starts ticked for the customer
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(optionalPatch(false, line))}>
              Make required
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => { void makeOptional(); }}>
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
