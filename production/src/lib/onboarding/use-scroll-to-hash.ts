/**
 * S31 — scroll to `#id` once that element exists. The setup checklist links to
 * /settings?tab=company#invoice-numbering; the settings tabs render after the user loads, so
 * the browser's own jump (which happens once, at navigation) finds nothing. This retries for
 * a short while and then gives up quietly — the page is still the right page.
 */
"use client";

import * as React from "react";

export function useScrollToHash(dep: unknown, tries = 20, everyMs = 150): void {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id) return;
    let left = tries;
    const t = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        window.clearInterval(t);
      } else if (--left <= 0) {
        window.clearInterval(t);
      }
    }, everyMs);
    return () => window.clearInterval(t);
  }, [dep, tries, everyMs]);
}
