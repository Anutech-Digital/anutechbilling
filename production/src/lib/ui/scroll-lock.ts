/**
 * Page-scroll lock for pop-ups, shared so two of them (and Razorpay) cannot leave the page frozen.
 *
 * Found 3 Oct 2026 (Pawan: "I can't scroll this page at all" on /done after paying): the checkout's
 * "Preparing your secure payment" card saved `body.style.overflow` and set it to "hidden"; Razorpay
 * opened while it showed, saved "hidden" as the value to restore, and on closing put "hidden" back —
 * after the card had already restored "". The customer then landed on /done with the page locked.
 *
 * So the lock is counted, never "save and restore": the page is locked while ANY pop-up holds it,
 * and `settlePageScroll()` re-applies the truth after something outside our control (Razorpay)
 * has touched the style.
 */
let holders = 0;

function apply(): void {
  if (typeof document === "undefined") return;
  document.body.style.overflow = holders > 0 ? "hidden" : "";
}

/** Lock page scrolling; call the returned function to release this hold (idempotent). */
export function lockPageScroll(): () => void {
  holders += 1;
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    apply();
  };
}

/** Put the page back to what our own holders say — after Razorpay (or anything else) changed it. */
export function settlePageScroll(): void {
  apply();
}

/** Test seam. */
export function pageScrollHolders(): number {
  return holders;
}
