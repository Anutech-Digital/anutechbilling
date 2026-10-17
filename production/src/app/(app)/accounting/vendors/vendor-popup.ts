/**
 * R-1511 — the vendor popup header showed an odd orange "highlight" on part of the
 * vendor name and GSTIN (Pardeep, staging, Net2Secure: "Lim|ited", "09AAICN3|949G1Z3").
 *
 * There is no search highlighting anywhere in this popup. The orange is the app's own
 * text-SELECTION colour (globals.css `::selection` = amber-ink on amber-soft). A vendor
 * row opens the popup on click, so a double/triple click (or a click-and-drag) on a row
 * keeps going after the popup has appeared under the pointer and selects a piece of the
 * header text — the name and GSTIN sit right where the pointer lands.
 *
 * Fix: when the popup opens, drop any selection the opening click left behind, and ignore
 * the extra clicks of that same multi-click for a short moment. Selecting the GSTIN on
 * purpose (drag, or double-click later) still works.
 */

/** A follow-up click of the multi-click that opened the popup, not a click of its own. */
export const CARRY_OVER_MS = 700;

export function isCarryOverClick(clickCount: number, msSinceOpen: number): boolean {
  return clickCount > 1 && msSinceOpen >= 0 && msSinceOpen < CARRY_OVER_MS;
}

/** Remove a text selection the opening click may have left (no-op on the server). */
export function clearStraySelection(): void {
  if (typeof window === "undefined") return;
  const sel = window.getSelection?.();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
}
