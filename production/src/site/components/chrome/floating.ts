"use client";
/**
 * When the website's one floating launcher shows, and when it steps aside.
 *
 * R-230 (6 Oct 2026): nothing floats on /checkout and /done — the page is the whole task.
 * R-464 (10 Oct 2026): at 390px the AI launcher and the WhatsApp pill covered the homepage
 * form ("Tell us what to automate"), its Name field included, and WhatsApp showed twice (the
 * hero's own "WhatsApp us" button plus the floating pill). Below 980px the site now floats ONE
 * action — the AI launcher (its panel still offers "WhatsApp us instead") — and that launcher
 * steps aside while any element marked `data-avoid-floating` (the form) is under it.
 * R-1498 (17 Oct 2026, Pawan on staging): on desktop the AI launcher and the WhatsApp pill still
 * stacked bottom-right and covered content. Now every width floats ONE launcher; pressing it
 * opens a small menu with "Chat with our AI sales agent" and "WhatsApp us" (AgentChat.tsx).
 * R-1495 2nd galat (Pawan, 24 Oct): at 1000–1280px (a laptop) the pill sat over the Workspace
 * plan cards' buttons and the FAQ rows — the step-aside only ran below 980px. It now runs at
 * EVERY width and asks the precise question: is a `data-avoid-floating` block inside the
 * launcher's own corner? Not "anywhere on screen" — so where the side margin keeps the content
 * clear of the corner (a wide screen, or a hero form on the left), the launcher simply stays.
 */
import { useEffect, useState } from "react";

/** Mark a page section with this attribute and no floating button ever sits over it. */
export const AVOID_FLOATING_ATTR = "data-avoid-floating";

/**
 * The bottom-right corner the launcher (plus a little air) takes, in px. Below 980px: the 48px
 * round icon at right/bottom 16px. Wider: the "Talk to us" pill (~115 x 45px) at right/bottom
 * 22px, with room for a wider font render.
 */
export function launcherZone(viewportWidth: number): { width: number; height: number } {
  return viewportWidth < 980 ? { width: 76, height: 76 } : { width: 176, height: 82 };
}

export function hideFloatingOn(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ["/checkout", "/done"].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type FloatingInput = {
  pathname: string | null | undefined;
  /** An element marked `data-avoid-floating` is (even partly) inside the launcher's corner. */
  avoidOnScreen: boolean;
  /** The launcher's menu or the AI chat panel is open — the launcher then stays, so the
   *  visitor can close it. */
  chatOpen?: boolean;
};

/** Pure rule: does the ONE floating launcher (AI chat + WhatsApp menu) show? */
export function floatingLauncher(i: FloatingInput): boolean {
  if (hideFloatingOn(i.pathname)) return false;
  // Any width: it steps aside while the form / plan cards / FAQ are under it (R-464, R-1495).
  return !i.avoidOnScreen || Boolean(i.chatOpen);
}

/**
 * True while any `[data-avoid-floating]` element is inside the launcher's corner (launcherZone):
 * the IntersectionObserver's root is the viewport shrunk to that corner with a negative
 * rootMargin, rebuilt when the window is resized.
 * Re-scans on every route change (the chrome lives in the layout, so it outlives the page that
 * holds the form) AND whenever the page's DOM changes — R-1495 (Pawan, 17 Oct, phone): a page
 * whose content arrives after the pathname changes (client navigation, a streamed server page,
 * a remount) was never watched, so the launcher sat over the Workspace plan cards' buttons.
 */
export function useAvoidFloating(pathname: string | null | undefined): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    setOnScreen(false);
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const watched = new Set<Element>();
    const onEntries = (entries: Array<Pick<IntersectionObserverEntry, "target" | "isIntersecting">>) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      setOnScreen(visible.size > 0);
    };
    const makeIO = () => {
      const w = document.documentElement.clientWidth || window.innerWidth;
      const h = document.documentElement.clientHeight || window.innerHeight;
      const zone = launcherZone(w);
      const top = Math.max(0, h - zone.height);
      const left = Math.max(0, w - zone.width);
      return new IntersectionObserver(onEntries, { rootMargin: `-${top}px 0px 0px -${left}px` });
    };
    let io = makeIO();
    const scan = () => {
      const now = new Set(document.querySelectorAll(`[${AVOID_FLOATING_ATTR}]`));
      let dropped = false;
      for (const el of watched) {
        if (now.has(el)) continue;
        io.unobserve(el);
        watched.delete(el);
        if (visible.delete(el)) dropped = true;
      }
      for (const el of now) {
        if (watched.has(el)) continue;
        watched.add(el);
        io.observe(el);
      }
      if (dropped) setOnScreen(visible.size > 0);
    };
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        io.disconnect();
        visible.clear();
        io = makeIO(); // its first callback reports every watched block afresh
        for (const el of watched) io.observe(el);
      });
    };
    scan();
    window.addEventListener("resize", onResize);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(scan);
    mo?.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      mo?.disconnect();
      io.disconnect();
    };
  }, [pathname]);
  return onScreen;
}
