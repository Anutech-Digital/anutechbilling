/**
 * Light/dark switch for the website's Warm theme (design artboard SiteHeader; docs/WEBSITE-THEME.md).
 * The Header renders it only when the website theme is "warm", so the Classic site never has it.
 *
 * Follows the device setting until the visitor chooses; the choice is kept in localStorage
 * `anutech-theme` and applied as `data-theme` on <html>. The (marketing) layout applies a stored
 * choice before the page paints (THEME_BOOT_SCRIPT), so a dark visitor never sees a light flash.
 * The dark colours live in site-warm.css ("Dark variant of the warm tokens") and src/site/warm/*.
 */
"use client";

import * as React from "react";

export const THEME_STORAGE_KEY = "anutech-theme";

/** Runs inline before paint: applies a saved choice; with none, the device setting decides (CSS). */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;

type Mode = "light" | "dark";

function currentMode(): Mode {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "dark" || set === "light") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeSwitch() {
  const [mode, setMode] = React.useState<Mode>("light");

  React.useEffect(() => {
    setMode(currentMode());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onDevice = () => setMode(currentMode());
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        document.documentElement.setAttribute("data-theme", e.newValue);
        setMode(e.newValue);
      }
    };
    mq.addEventListener("change", onDevice);
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onDevice);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const dark = mode === "dark";
  const toggle = () => {
    const next: Mode = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (private mode): the switch still works for this page view.
    }
    setMode(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="w-tt"
      onClick={toggle}
    >
      <span className="w-tt-track" aria-hidden="true">
        <span className="w-tt-knob">
          {dark ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></svg>
          )}
        </span>
      </span>
    </button>
  );
}
