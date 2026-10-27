/**
 * R-1899 (25 Oct 2026) — one row style for every statement report (P&L, Balance Sheet, Trial
 * Balance, GST 3B worksheet, Cash flow).
 *
 * Pardeep, on the staging P&L: "kisi row ke upar mouse aane par wo poori row highlight honi
 * chahiye". On a long statement line the label sits far left and the amount far right; without a
 * band across the row the eye can jump to the neighbouring amount.
 *
 * - Hover (only on devices that really hover — a phone never gets a stuck tint after a tap) and
 *   keyboard focus inside the row (Tab onto a drill-down button) paint the whole row `paper-2`.
 *   `paper-2` is a design token with its own dark value (globals.css), so dark mode just works.
 * - Contrast, computed not eyeballed (light mode): `text-rose` on `paper` is 4.52:1 and on
 *   `paper-2` only 4.23:1 — under the 4.5:1 AA floor. So inside a highlighted row red figures
 *   switch to `rose-ink` (6.81:1 on paper-2), and `text-amber` (4.22 on paper-2) to `amber-ink`
 *   (6.22). ink, ink-2, ink-3 (4.78) and emerald (4.79) stay above 4.5. Dark mode: every one of
 *   these is 5.0:1 or more on paper-2 (statement-row.test.tsx computes both from globals.css).
 * - Cursor: a row gets `cursor-pointer` only when the row itself is clickable (`clickable`).
 *   Rows whose only action is a button inside keep the default cursor; the button has its own.
 *
 * Use <StatementRow> for a <div> row, or spread STATEMENT_ROW into a <tr>'s className.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

/** Hover / focus-within highlight for any statement row (<div> or <tr>). */
export const STATEMENT_ROW = [
  "transition-colors motion-reduce:transition-none",
  "[@media(hover:hover)]:hover:bg-paper-2",
  "focus-within:bg-paper-2",
  "[@media(hover:hover)]:[&:hover_.text-rose]:text-rose-ink",
  "[&:focus-within_.text-rose]:text-rose-ink",
  "[@media(hover:hover)]:[&:hover_.text-amber]:text-amber-ink",
  "[&:focus-within_.text-amber]:text-amber-ink",
].join(" ");

/** A <div> row: bleeds 8px past the text on both sides so the band reads as the full row. */
export const STATEMENT_ROW_BLEED = "-mx-2 px-2 rounded-md";

export const StatementRow = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { clickable?: boolean; bleed?: boolean }
>(({ className, clickable, bleed = true, ...props }, ref) => (
  <div
    ref={ref}
    data-statement-row=""
    className={cn(STATEMENT_ROW, bleed && STATEMENT_ROW_BLEED, clickable && "cursor-pointer", className)}
    {...props}
  />
));
StatementRow.displayName = "StatementRow";
