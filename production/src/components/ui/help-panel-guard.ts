/**
 * R-827 (Abhishek, staging: "help khula ho to page / dialog par click ya type nahi hota"):
 * AI Help is meant to sit beside the work — read a step, do it in the page or in an open
 * dialog, read the next one. A Radix modal Dialog fights that in four ways:
 *   1. body gets `pointer-events: none` → the help panel cannot be clicked;
 *   2. a pointer-down / focus outside the dialog closes it (onInteractOutside);
 *   3. its focus trap pulls focus back the moment you click into the help box;
 *   4. its scroll lock swallows the mouse wheel over the help chat.
 * This file is the one shared fix: the shared ui/dialog asks `keepOpenForHelp` before it
 * closes, and the help panel installs `installHelpPanelGuard` on its own root.
 */

/** Everything AI Help renders sits inside this (the panel, the minimized bar, "Ask AI", the crop overlay). */
export const HELP_PANEL_SELECTOR = "[data-ai-help]";

export function isInHelpPanel(target: EventTarget | null | undefined): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest(HELP_PANEL_SELECTOR) !== null;
}

/** Radix "outside" events are CustomEvents whose real event is in detail.originalEvent. */
function outsideTarget(e: Event): EventTarget | null {
  const original = (e as CustomEvent<{ originalEvent?: Event } | undefined>).detail?.originalEvent;
  return original?.target ?? e.target;
}

/* R-827 follow-up (browser check, 11 Oct): Radix can report a pointer-down "outside" only
   AFTER the click ran (deferred to the click event). A help button that removes itself on
   click — the minimized "Open help" bar, "Ask AI", a follow-up chip — is detached from the
   page by then, so closest("[data-ai-help]") finds nothing and the dialog closed. The last
   element pressed inside help is remembered (window capture, before anything is removed). */
let lastHelpPress: EventTarget | null = null;

/** Remember the element a pointer went down on, when it is inside help (else forget). */
export function noteHelpPress(target: EventTarget | null): void {
  lastHelpPress = isInHelpPanel(target) ? target : null;
}

/** Inside help now, or the help element that was just pressed (it may have been removed since). */
export function cameFromHelp(target: EventTarget | null | undefined): boolean {
  return isInHelpPanel(target) || (target != null && target === lastHelpPress);
}

/**
 * Wrap a dialog's onInteractOutside / onEscapeKeyDown: the caller's own handler still runs,
 * then a click, focus or Escape that came from the help panel never closes the dialog.
 */
export function keepOpenForHelp<E extends Event>(handler?: (e: E) => void): (e: E) => void {
  return (e: E) => {
    handler?.(e);
    if (cameFromHelp(outsideTarget(e))) e.preventDefault();
  };
}

const MODAL = "[role=dialog],[role=alertdialog]";

/**
 * Lets the help panel work while a modal dialog is open. Returns the clean-up.
 *  - focus moving INTO help is not reported to the dialog's focus trap / dismiss layer
 *    (focusin stops at the panel root; the dialog's focusout is stopped at window capture
 *    only when focus is going from a dialog into help);
 *  - wheel / touch-scroll inside help never reach the dialog's scroll lock.
 */
export function installHelpPanelGuard(root: HTMLElement): () => void {
  const stop = (e: Event) => e.stopPropagation();
  const onPress = (e: Event) => noteHelpPress(e.target);
  const onFocusOut = (e: FocusEvent) => {
    const from = e.target;
    if (!isInHelpPanel(e.relatedTarget) || isInHelpPanel(from)) return;
    if (from instanceof Element && from.closest(MODAL)) e.stopPropagation();
  };
  root.addEventListener("focusin", stop);
  root.addEventListener("wheel", stop, { passive: true });
  root.addEventListener("touchmove", stop, { passive: true });
  window.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("pointerdown", onPress, true);
  return () => {
    window.removeEventListener("pointerdown", onPress, true);
    lastHelpPress = null;
    root.removeEventListener("focusin", stop);
    root.removeEventListener("wheel", stop);
    root.removeEventListener("touchmove", stop);
    window.removeEventListener("focusout", onFocusOut, true);
  };
}
