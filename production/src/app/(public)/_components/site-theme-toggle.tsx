/**
 * Light/dark switch for the public website (design: SiteHeader artboard).
 *
 * Reads the theme the boot script in site-theme.tsx already applied, so the
 * switch never disagrees with the page. Saves the visitor's choice to
 * localStorage `anutech-theme`, and follows changes made in another tab.
 */
"use client";

import * as React from "react";

export const THEME_STORAGE_KEY = "anutech-theme";

type SiteThemeName = "light" | "dark";

function readApplied(): SiteThemeName {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function apply(theme: SiteThemeName, save: boolean): void {
  const root = document.documentElement;
  if (save) {
    // Animate the colour change only when the visitor flips the switch.
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 500);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode / blocked storage: the switch still works for this page view.
    }
  }
  root.setAttribute("data-theme", theme);
}

export function SiteThemeToggle() {
  const [theme, setTheme] = React.useState<SiteThemeName>("light");

  React.useEffect(() => {
    setTheme(readApplied());
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        apply(e.newValue, false);
        setTheme(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isDark = theme === "dark";
  const toggle = () => {
    const next: SiteThemeName = isDark ? "light" : "dark";
    apply(next, true);
    setTheme(next);
  };

  return (
    <button type="button" role="switch" aria-checked={isDark} aria-label="Dark theme" className="tt" onClick={toggle}>
      <span className="tt-track" aria-hidden="true">
        <span className="tt-ico tt-sun"><SunIcon /></span>
        <span className="tt-ico tt-moon"><MoonIcon /></span>
        <span className="tt-knob">
          <span className="tt-k tt-ksun"><SunIcon /></span>
          <span className="tt-k tt-kmoon"><MoonIcon /></span>
        </span>
      </span>
      <span className="tt-tip" aria-hidden="true">
        {isDark ? "Switch to light theme" : "Switch to dark theme"}
      </span>
    </button>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" />
    </svg>
  );
}
