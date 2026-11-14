/**
 * Back-to-top button with a scroll-progress ring — the Warm theme's (docs/WEBSITE-THEME.md,
 * design artboard SiteHeader). The (marketing) layout renders it ONLY when the website theme is
 * "warm", so the Classic site never has it.
 *
 * Desktop only (980px and wider), on purpose: R-230 / R-1498 cut the phone's floating boxes down to
 * the one chat launcher because they covered the bottom of every page — a second round button would
 * undo that. Hidden on /checkout and /done like every floating box (hideFloatingOn). It sits above
 * the launcher and below the launcher's open menu (z-index 90 < 96), so the menu always wins.
 */
"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { hideFloatingOn } from "@/site/components/chrome/floating";

const RING = 150.8; // circumference of r = 24
const SHOW_AFTER_PX = 480;
const DESKTOP = "(min-width: 980px)";

export function BackToTop() {
  const pathname = usePathname();
  const [desktop, setDesktop] = React.useState(false);
  const [shown, setShown] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const el = document.scrollingElement ?? document.documentElement;
        const max = Math.max(1, el.scrollHeight - window.innerHeight);
        const y = window.scrollY || el.scrollTop || 0;
        setShown(y > SHOW_AFTER_PX);
        setProgress(Math.min(1, y / max));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  if (!desktop || hideFloatingOn(pathname)) return null;

  const toTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      className="w-to-top"
      aria-label="Back to top"
      data-shown={shown ? "true" : "false"}
      tabIndex={shown ? 0 : -1}
      onClick={toTop}
    >
      <svg aria-hidden="true" width="56" height="56" viewBox="0 0 56 56" className="w-to-top-ring">
        <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
        <circle
          cx="28" cy="28" r="24" fill="none" stroke="#F4B740" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={RING} strokeDashoffset={(RING * (1 - progress)).toFixed(1)}
        />
      </svg>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="w-to-top-arrow">
        <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
      </svg>
    </button>
  );
}
