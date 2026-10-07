"use client";
/**
 * R-393 (Pardeep, 7 Oct 2026: "Re-triage ka kya kaam hai") — triage runs on its own when a
 * report is filed, so re-running it is a rare fix-up, not a daily action. It lives inside the
 * card's Details panel instead of the action row, with one line saying when to use it.
 * The caller passes the same useTriageFeedback handler the old row button used.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export const RECHECK_LABEL = "Re-check type & score";
export const RECHECK_HINT = "Use if the type or severity looks wrong, or AI was down when it was filed.";

export function RecheckTypeScore({ onRun, disabled }: { onRun: () => void; disabled: boolean }) {
  return (
    <div data-testid="recheck-type-score" className="flex items-center gap-2 flex-wrap">
      <Button size="sm" variant="outline" onClick={onRun} disabled={disabled}>
        <Icon name="refresh" size={14} className="mr-1.5" />
        {RECHECK_LABEL}
      </Button>
      <span className="text-xs text-ink-3">{RECHECK_HINT}</span>
    </div>
  );
}
