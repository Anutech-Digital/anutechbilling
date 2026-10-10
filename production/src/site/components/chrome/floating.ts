"use client";
/**
 * Which floating buttons (AI sales agent launcher, WhatsApp pill) the website shows, and when
 * they step aside.
 *
 * R-230 (6 Oct 2026): nothing floats on /checkout and /done — the page is the whole task.
 * R-464 (10 Oct 2026): at 390px the AI launcher and the WhatsApp pill covered the homepage
 * form ("Tell us what to automate"), its Name field included, and WhatsApp showed twice (the
 * hero's own "WhatsApp us" button plus the floating pill). Below 980px the site now floats ONE
 * action — the AI launcher (its panel still offers "WhatsApp us instead") — and that launcher
 * steps aside while any element marked `data-avoid-floating` (the form) is on screen.
 * Desktop is unchanged.
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
  /** The real WhatsApp number is configured (WHATSAPP_READY). */
  whatsappReady: boolean;
  /** The AI chat panel is open — its launcher then stays, so the visitor can close it. */
  chatOpen?: boolean;
};

export type FloatingButtons = { agent: boolean; whatsapp: boolean };

/** Pure rule: which floating buttons to show. */
export function floatingButtons(i: FloatingInput): FloatingButtons {
  if (hideFloatingOn(i.pathname)) return { agent: false, whatsapp: false };
  if (i.isMobile) {
    // One floating action on a phone; it steps aside while the form is on screen.
    return { agent: !i.avoidOnScreen || Boolean(i.chatOpen), whatsapp: false };
  }
  return { agent: true, whatsapp: i.whatsappReady };
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
 * (the chrome lives in the layout, so it outlives the page that holds the form).
 */
export function useAvoidFloating(pathname: string | null | undefined): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    setOnScreen(false);
    if (typeof IntersectionObserver === "undefined") return;
    const els = Array.from(document.querySelectorAll(`[${AVOID_FLOATING_ATTR}]`));
    if (els.length === 0) return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      setOnScreen(visible.size > 0);
    });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);
  return onScreen;
}
