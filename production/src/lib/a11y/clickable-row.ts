/**
 * R-1658 (24 Oct 2026) — a table row that opens something on click must open it from the
 * keyboard too (WCAG 2.1.1). Spread `rowActivation(fn)` on the <tr> and add ROW_FOCUS_RING to
 * its className:
 *
 *   <tr {...rowActivation(() => open(r))} className={cn("…", ROW_FOCUS_RING)}>
 *
 * - tabIndex 0: Tab stops on the row.
 * - Enter / Space open it, the same as a click. Only when the ROW itself has focus — Enter on a
 *   checkbox or button inside the row keeps doing that control's own job.
 * - The row keeps its native `row` role: role="button" on a <tr> would take it out of the table,
 *   so a screen reader could no longer read it cell by cell with its column headers.
 * - The ring is an inset outline, because a box-shadow ring is not painted on a <tr> in every
 *   browser and an outer one is clipped by the table's card.
 */
import type * as React from "react";

export const ROW_FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber";

export function rowActivation(onActivate: () => void): {
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
