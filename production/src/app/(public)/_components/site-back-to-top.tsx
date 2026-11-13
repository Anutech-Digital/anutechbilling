/**
 * Back-to-top button with a scroll-progress ring (design: SiteHeader artboard).
 * Appears after ~480px of scroll. Respects prefers-reduced-motion.
 */
"use client";

import * as React from "react";

const RING = 150.8; // circumference of r=24
const SHOW_AFTER_PX = 480;

interface SiteBackToTopProps {
  /** Sit higher, for pages that already have a floating button bottom-right. */
  raised?: boolean;
}

export function SiteBackToTop({ raised = false }: SiteBackToTopProps) {
  const [shown, setShown] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
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
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  const toTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      className={`to-top ${raised ? "bottom-24" : "bottom-[clamp(16px,3vw,32px)]"}`}
      aria-label="Back to top"
      data-shown={shown ? "true" : "false"}
      tabIndex={shown ? 0 : -1}
      onClick={toTop}
    >
      <svg aria-hidden="true" width="56" height="56" viewBox="0 0 56 56" className="absolute inset-0 -rotate-90">
        <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
        <circle
          cx="28" cy="28" r="24" fill="none" stroke="#F4B740" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={RING}
          strokeDashoffset={(RING * (1 - progress)).toFixed(1)}
          className="transition-[stroke-dashoffset] duration-150 ease-linear"
        />
      </svg>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="relative">
        <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
      </svg>
    </button>
  );
}
