"use client";

import * as React from "react";
import { toggleHelpReport } from "@/components/shared/ai-help";
import { findShortcut, matchesShortcut } from "@/lib/keyboard/shortcuts";

/**
 * Ctrl+Shift+B, on every app page. R-383 (7 Oct 2026): it opens the one Help panel on its
 * "Report a problem" tab — the separate Report Bug dialog it used to open is gone from the
 * header. Pressed again while that tab is showing, it closes the panel.
 */
export function GlobalBugReporter() {
  /* The keys come from the registry, not from this file.
     They used to be spelled out here as `ctrlKey && shiftKey && key === "b"`, and the
     shortcut was in no registry at all — so the cheat sheet did not list it and the
     tooltip could not mention it. Reading the entry means the handler, the cheat sheet and
     the tooltip badge cannot disagree about which keys work. */
  React.useEffect(() => {
    const reportBug = findShortcut("report-bug");
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(reportBug, e)) {
        e.preventDefault();
        toggleHelpReport();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return null;
}
