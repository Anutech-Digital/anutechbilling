/**
 * R-1427 (Pawan, staging 17 + 24 Oct: "More menu se koi bhi dialog band karne ke baad Filter aur
 * lead rows click nahi hote — body par pointer-events: none atka rehta hai").
 *
 * A Radix modal layer (Dialog, Sheet, modal DropdownMenu, Select) sets `body { pointer-events:
 * none }` while it is open and, when the LAST such layer goes, puts back the value it saved when
 * the FIRST one opened. If that saved value was already "none" — a modal menu still on screen
 * when the dialog mounted, with two copies of @radix-ui/react-dismissable-layer in the bundle
 * (the first R-1427 cause: react-menu carried 1.1.11, react-dialog 1.1.19), each with its own
 * memory — Close put "none" back and the page stayed frozen until a reload.
 *
 * The shared ui/dialog and ui/sheet render <ReleaseStaleBodyLock /> inside their content. After
 * the content unmounts it checks the page: while any modal layer is still MOUNTED (Radix gives
 * every modal layer and dialog overlay an inline `pointer-events` while body is locked — open, or
 * still animating closed) the lock may be real, so nothing is touched; a closing one is waited
 * for (a few short retries). When none is left and body is still `pointer-events: none`, that
 * lock belongs to nobody and is released.
 */
import * as React from "react";

/** A mounted Radix modal layer / overlay: data-state plus Radix's inline pointer-events. */
const LAYER = "[data-state][style*='pointer-events']";
const OPEN_LAYER = "[data-state=open][style*='pointer-events']";
const RETRY_MS = 100;
const MAX_TRIES = 30; // ~3 s — longer than any close animation in ui/dialog / ui/sheet

export type BodyLockCheck = "released" | "not-locked" | "held" | "closing";

/** One look at the page. Releases body's pointer-events lock only when no modal layer is mounted. */
export function releaseStaleBodyLock(doc: Document = document): BodyLockCheck {
  const body = doc.body;
  if (!body || body.style.pointerEvents !== "none") return "not-locked";
  if (doc.querySelector(OPEN_LAYER)) return "held";
  if (doc.querySelector(LAYER)) return "closing";
  body.style.pointerEvents = "";
  return "released";
}

/** Look now (next tick), and again while a layer is still animating closed. */
function scheduleRelease(tries = MAX_TRIES): void {
  window.setTimeout(() => {
    if (releaseStaleBodyLock(document) === "closing" && tries > 1) scheduleRelease(tries - 1);
  }, tries === MAX_TRIES ? 0 : RETRY_MS);
}

/** Drop inside a modal layer's content: when it unmounts, a lock nobody owns is released. */
export function ReleaseStaleBodyLock(): null {
  // Only an unmount clean-up — nothing runs while the layer is open. The tick lets Radix's own
  // clean-up (it restores body in an effect clean-up) run first.
  React.useEffect(() => () => {
    if (typeof window !== "undefined") scheduleRelease();
  }, []);
  return null;
}
