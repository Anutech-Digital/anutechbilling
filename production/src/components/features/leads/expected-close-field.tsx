"use client";
/**
 * The drawer's "Kab tak band hogi?" — the deal's expected close date, editable in place
 * (Deals audit, 30 Sep 2026: `leads.expected_close_date` existed but no screen wrote it).
 *
 * Plain `YYYY-MM-DD` (the column is `date`), validated by the same parser the follow-up cell
 * uses; the picker starts at today (IST). A date already in the past is shown — rose, with
 * "overdue" — rather than refused, so an overdue deal can be looked at before it is re-dated.
 */
import * as React from "react";
import { toast } from "sonner";
import type { Lead } from "@/lib/supabase/database.types";
import { useUpdateLead } from "@/lib/queries/leads";
import { parseFollowUpDate } from "@/lib/leads/inline-edit";
import { isCloseOverdue, needsDealDetails } from "@/lib/leads/deal-rules";
import { istToday } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";

export function ExpectedCloseField({ lead }: { lead: Pick<Lead, "id" | "stage" | "expected_close_date"> }) {
  const updateLead = useUpdateLead({ quiet: true });
  const today = istToday();
  const saved = lead.expected_close_date ?? "";
  const overdue = isCloseOverdue(lead, today);
  const required = needsDealDetails(lead.stage);

  const save = (raw: string) => {
    const parsed = parseFollowUpDate(raw);
    if (!parsed.ok) { toast.error(parsed.error, { description: "Type a date like 15 Oct, or pick one from the calendar." }); return; }
    if (parsed.value === (lead.expected_close_date ?? null)) return;
    if (parsed.value && parsed.value < today) { toast.error("Pick today or later.", { description: "The expected close date can't be in the past." }); return; }
    if (!parsed.value && required) {
      toast.error("Expected close is required", { description: "Deals from Quote Sent onward need a date. You can change it, not remove it." });
      return;
    }
    updateLead.mutate({ id: lead.id, patch: { expected_close_date: parsed.value } });
  };

  return (
    <div>
      <label htmlFor={`close-${lead.id}`} className="block text-2xs uppercase tracking-wider text-ink-3 mb-0.5">
        Expected close
      </label>
      <input
        id={`close-${lead.id}`}
        type="date"
        min={today}
        defaultValue={saved}
        key={saved}
        /* Typing into a date box fires change per segment ("0002-10-15" on the way to
           2026) — so a change saves only a finished, valid, not-past date quietly, and blur
           says what is wrong with anything else. */
        onChange={(e) => { const v = e.target.value; if (v >= today && parseFollowUpDate(v).ok) save(v); }}
        onBlur={(e) => save(e.target.value)}
        aria-describedby={overdue ? `close-${lead.id}-overdue` : undefined}
        className={cn(
          "w-full rounded-md border bg-paper px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40",
          overdue ? "border-rose text-rose" : "border-hairline",
        )}
      />
      {overdue && (
        <p id={`close-${lead.id}-overdue`} className="mt-0.5 text-xs font-semibold text-rose">
          Overdue — update date
        </p>
      )}
      {!saved && required && (
        <p className="mt-0.5 text-xs text-ink-3">No date — left out of the forecast and &ldquo;Closing this month&rdquo;.</p>
      )}
    </div>
  );
}
