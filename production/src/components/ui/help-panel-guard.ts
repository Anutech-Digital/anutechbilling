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

/* R-2386 (Private Vault → Banking → New account, 2 Nov: "Type dropdown mouse se click karo to
   poora dialog band"): a Select / Popover / Combobox list opened from a dialog is PORTALLED to
   the end of <body>, outside the dialog's DOM box. Whenever Radix reports a press there as
   "outside" — a list portalled by a component that is not a React child of the dialog, or a
   press reported after the pick already removed the list — the dialog closed with the pick.
   A press inside any portalled popover list is never "outside" the dialog. */
export const POPOVER_LIST_SELECTOR =
  "[data-radix-popper-content-wrapper],[data-radix-select-viewport],[role=listbox]";

let lastPopoverPress: EventTarget | null = null;

/** Remember a pointer-down inside a popover list (window capture, before the pick removes it). */
export function notePopoverPress(target: EventTarget | null): void {
  lastPopoverPress = typeof Element !== "undefined" && target instanceof Element && target.closest(POPOVER_LIST_SELECTOR)
    ? target : null;
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => notePopoverPress(e.target), true);
}

/** Inside a portalled popover list now, or the list element that was just pressed (maybe removed since). */
export function isInPortalledPopover(target: EventTarget | null | undefined): boolean {
  if (target == null) return false;
  if (target === lastPopoverPress) return true;
  return typeof Element !== "undefined" && target instanceof Element && target.closest(POPOVER_LIST_SELECTOR) !== null;
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

/**
 * Wrap a dialog's onInteractOutside (only — never Escape): a press or focus inside a
 * portalled popover list never closes the dialog (R-2386).
 */
export function keepOpenForPopover<E extends Event>(handler?: (e: E) => void): (e: E) => void {
  return (e: E) => {
    handler?.(e);
    if (isInPortalledPopover(outsideTarget(e))) e.preventDefault();
  };
}

/* R-2172 (R-2168 Sandbox dialog, R-2095b reconcile drawer: "Save kiya, kuch hua hi nahi"): the
   toaster lives at the end of <body>, outside every dialog/sheet. ui/toaster turns pointer
   events back on for it while a modal has body at `pointer-events: none`, so a toast's ✕ or
   action button takes the click — and that press must not count as "outside" and close the
   dialog/sheet whose error the toast is reporting. The last press is remembered because a
   toast button can remove its toast before a deferred (touch) "outside" report arrives. */
export const TOAST_SELECTOR = "[data-sonner-toaster]";

let lastToastPress: EventTarget | null = null;

/** Inside the toaster now, or the toast element that was just pressed (maybe removed since). */
export function isInToaster(target: EventTarget | null | undefined): boolean {
  if (target == null) return false;
  if (target === lastToastPress) return true;
  return typeof Element !== "undefined" && target instanceof Element && target.closest(TOAST_SELECTOR) !== null;
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => {
    const t = e.target;
    lastToastPress = typeof Element !== "undefined" && t instanceof Element && t.closest(TOAST_SELECTOR) ? t : null;
  }, true);
}

/** Wrap a dialog's / sheet's onInteractOutside: a press or focus on a toast never closes it (R-2172). */
export function keepOpenForToast<E extends Event>(handler?: (e: E) => void): (e: E) => void {
  return (e: E) => {
    handler?.(e);
    if (isInToaster(outsideTarget(e))) e.preventDefault();
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
