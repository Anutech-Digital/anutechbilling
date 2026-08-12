"use client";

import * as React from "react";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";

export function GlobalBugReporter() {
  const [open, setOpen] = React.useState(false);

  // Global Keyboard Shortcut: Ctrl + Shift + B or Cmd + Shift + B
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return <FeedbackDialog open={open} onOpenChange={setOpen} />;
}
