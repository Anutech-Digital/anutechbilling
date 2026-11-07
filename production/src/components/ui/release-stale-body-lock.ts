/**
 * R-1427 (Pawan, staging 17 + 24 Oct: "More menu se koi bhi dialog band karne ke baad Filter aur
 * lead rows click nahi hote — body par pointer-events: none atka rehta hai").
 *
 * A Radix modal layer (Dialog, Sheet, modal DropdownMenu, Select) sets `body { pointer-events:
 * none }` while it is open and, when the LAST such layer closes, puts back the value it saved
 * when the FIRST one opened. If that saved value was already "none" — a modal menu still on
 * screen when the dialog mounted, with two copies of @radix-ui/react-dismissable-layer in the
 * bundle (the first R-1427 cause: react-menu carried 1.1.11, react-dialog 1.1.19), each with its
 * own memory — Close put "none" back and the page stayed frozen until a reload.
 *
 * The shared ui/dialog and ui/sheet render `useReleaseStaleBodyLockOnUnmount` inside their
 * content: one tick after the content unmounts (after every layer's own clean-up has run), if
 * body is still `pointer-events: none` and no modal layer is open any more, that stale lock is
 * released. While any dialog / menu / listbox is still open nothing is touched — that lock is real.
 */
import * as React from "react";

/** Radix layers that may legitimately hold `body { pointer-events: none }` while open. */
export const OPEN_LAYER_SELECTOR = [
  "[role=dialog][data-state=open]",
  "[role=alertdialog][data-state=open]",
  "[role=menu][data-state=open]",
  "[role=listbox][data-state=open]",
].join(",");

/** Release a body pointer-events lock that no open layer owns. Returns true when it did. */
export function releaseStaleBodyLock(doc: Document = document): boolean {
  const body = doc.body;
  if (!body || body.style.pointerEvents !== "none") return false;
  if (doc.querySelector(OPEN_LAYER_SELECTOR)) return false;
  body.style.pointerEvents = "";
  return true;
}

/** One tick after the calling layer unmounts, release a stale body lock (see above). */
export function useReleaseStaleBodyLockOnUnmount(): void {
  // Only an unmount clean-up — nothing runs while the layer is open. The tick lets Radix's own
  // clean-up (it restores body in an effect clean-up) run first.
  React.useEffect(() => () => {
    if (typeof window === "undefined") return;
    window.setTimeout(() => releaseStaleBodyLock(document), 0);
  }, []);
}

/** The same, as an element to drop inside a layer's content (for components without a body). */
export function ReleaseStaleBodyLock(): null {
  useReleaseStaleBodyLockOnUnmount();
  return null;
}
