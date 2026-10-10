/**
 * R-836 (10 Oct 2026) — the mouse wheel must never change a number box.
 *
 * Browsers step a FOCUSED <input type="number"> on wheel: in the 1-Click Onboard dialog,
 * scrolling the page while the price box still had focus turned ₹150 into ₹149 with nothing
 * on screen to say so. On wheel over a focused number input we blur it — the value stays,
 * and the wheel goes on to scroll the page / dialog as the user meant. (preventDefault would
 * also stop the step, but it stops the scroll too, and needs a non-passive listener.)
 *
 * Two layers use this one rule:
 *   - <Input type="number"> (components/ui/input) handles it on its own element;
 *   - installNumberWheelGuard() — mounted once in <Providers> — catches every raw
 *     <input type="number"> in the app, so a new form cannot reintroduce the bug.
 */

/** True when `el` is a number input that the wheel would step right now. */
export function isFocusedNumberInput(el: EventTarget | null, doc: Document = document): el is HTMLInputElement {
  return (
    !!el &&
    (el as HTMLElement).tagName === "INPUT" &&
    (el as HTMLInputElement).type === "number" &&
    doc.activeElement === el
  );
}

/** Blur a focused number input under the wheel, so its value cannot change. */
export function blurNumberInputOnWheel(target: EventTarget | null, doc: Document = document): boolean {
  if (!isFocusedNumberInput(target, doc)) return false;
  target.blur();
  return true;
}

/**
 * Document-wide guard: one capture-phase, passive wheel listener. Returns the cleanup.
 * Passive is enough — we never cancel the event, so scrolling stays smooth.
 */
export function installNumberWheelGuard(doc: Document = document): () => void {
  const onWheel = (e: WheelEvent) => { blurNumberInputOnWheel(e.target, doc); };
  doc.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => doc.removeEventListener("wheel", onWheel, { capture: true });
}
