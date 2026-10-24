"use client";
/**
 * "Band: 15 Oct" — a deal's expected close date on a card or row (lib/leads/deal-rules.ts).
 * An OPEN deal past its date turns rose and says "overdue" in words, not only in colour.
 * A WON deal shows "Won on <date>" — the day it was won, never its (possibly future)
 * expected close (R-1477). Renders nothing for a lost deal or one with no date.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { closeDateShort, isCloseOverdue, wonOnDate } from "@/lib/leads/deal-rules";
import { istToday } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";

export function CloseDateBadge({ lead, className }: {
  lead: Pick<Lead, "stage" | "expected_close_date" | "stage_changed_at" | "updated_at">;
  className?: string;
}) {
  if (lead.stage === "lost") return null;
  const wonOn = wonOnDate(lead);
  if (wonOn) {
    return (
      <span title="Won on" className={cn("tabular-nums whitespace-nowrap text-ink-3", className)}>
        Won on {closeDateShort(wonOn)}
      </span>
    );
  }
  if (!lead.expected_close_date || lead.stage === "won") return null;
  const overdue = isCloseOverdue(lead, istToday());
  return (
    <span
      title={overdue ? "Overdue — update date" : "Expected close"}
      className={cn("tabular-nums whitespace-nowrap", overdue ? "font-semibold text-rose" : "text-ink-3", className)}
    >
      Close: {closeDateShort(lead.expected_close_date)}{overdue ? " · overdue" : ""}
    </span>
  );
}
