"use client";
/**
 * When the website's one floating launcher shows, and when it steps aside.
 *
 * R-230 (6 Oct 2026): nothing floats on /checkout and /done — the page is the whole task.
 * R-464 (10 Oct 2026): at 390px the AI launcher and the WhatsApp pill covered the homepage
 * form ("Tell us what to automate"), its Name field included, and WhatsApp showed twice (the
 * hero's own "WhatsApp us" button plus the floating pill). Below 980px the site now floats ONE
 * action — the AI launcher (its panel still offers "WhatsApp us instead") — and that launcher
 * steps aside while any element marked `data-avoid-floating` (the form) is on screen.
 * R-1498 (17 Oct 2026, Pawan on staging): on desktop the AI launcher and the WhatsApp pill still
 * stacked bottom-right and covered content. Now every width floats ONE launcher; pressing it
 * opens a small menu with "Chat with our AI sales agent" and "WhatsApp us" (AgentChat.tsx).
 */
import { useEffect, useState } from "react";

/** The site's phone/tablet breakpoint — the same 980px the R-230 rules use. */
export const FLOATING_MOBILE_QUERY = "(max-width: 979px)";

/** Mark a page section with this attribute and, on a phone, no floating button covers it. */
export const AVOID_FLOATING_ATTR = "data-avoid-floating";

export function hideFloatingOn(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ["/checkout", "/done"].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type FloatingInput = {
  pathname: string | null | undefined;
  /** Viewport is below 980px. */
  isMobile: boolean;
  /** An element marked `data-avoid-floating` is (even partly) on screen. */
  avoidOnScreen: boolean;
  /** The launcher's menu or the AI chat panel is open — the launcher then stays, so the
   *  visitor can close it. */
  chatOpen?: boolean;
};

/** Pure rule: does the ONE floating launcher (AI chat + WhatsApp menu) show? */
export function floatingLauncher(i: FloatingInput): boolean {
  if (hideFloatingOn(i.pathname)) return false;
  // On a phone it steps aside while the form / plan cards are on screen (R-464, R-1495).
  if (i.isMobile) return !i.avoidOnScreen || Boolean(i.chatOpen);
  return true;
}

/** True below 980px. False on the server and before mount (desktop = the old behaviour). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(FLOATING_MOBILE_QUERY);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return mobile;
}

/**
 * True while any `[data-avoid-floating]` element is on screen. Re-scans on every route change
 * (the chrome lives in the layout, so it outlives the page that holds the form) AND whenever
 * the page's DOM changes — R-1495 (Pawan, 17 Oct, phone): a page whose content arrives after
 * the pathname changes (client navigation, a streamed server page, a remount) was never
 * watched, so the launcher sat over the Workspace plan cards' buttons.
 */
export function useAvoidFloating(pathname: string | null | undefined): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    setOnScreen(false);
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const watched = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      setOnScreen(visible.size > 0);
    });
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
    scan();
    if (typeof MutationObserver === "undefined") return () => io.disconnect();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { mo.disconnect(); io.disconnect(); };
  }, [pathname]);
  return onScreen;
}
