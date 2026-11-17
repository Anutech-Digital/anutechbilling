"use client";

/**
 * R-2243: "Why customers leave (last 12 months)" — the count of Cancel subscription and Won't renew by the
 * picklist reason (lib/subscriptions/leave-reasons.ts), next to the churn numbers on SaaS Metrics.
 * Subscriptions that left before the picklist existed show as "Not recorded" — never dropped, so the
 * shares never read as if every departure had been explained.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { leaveReasonCounts, type LeaverRow } from "@/lib/subscriptions/leave-reasons";

function useLeavers() {
  return useQuery({
    queryKey: ["accounting", "leave-reasons"],
    queryFn: async (): Promise<LeaverRow[]> => {
      const supabase = createClient();
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      const since = from.toISOString();
      /* Only rows that were cancelled or marked Won't renew inside the window — paged, a bare select stops at 1000. */
      return (await fetchAllRows((a, b) => supabase
        .from("subscriptions")
        .select("id, status, auto_renew, cancelled_at, non_renew_set_at, leave_reason_code")
        .or(`cancelled_at.gte.${since},non_renew_set_at.gte.${since}`)
        .order("id")
        .range(a, b))) as LeaverRow[];
    },
  });
}

/** The card's body — separate from the query so it can be tested with rows in hand. */
export function LeaveReasonsView({ rows, now }: { rows: ReadonlyArray<LeaverRow>; now?: Date }) {
  const { total, rows: counts } = React.useMemo(() => leaveReasonCounts(rows, now), [rows, now]);
  return (
    <Card className="p-5 md:p-6 mb-6 print-keep" data-testid="leave-reasons-card">
      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
        Why customers leave (last 12 months)
      </div>
      <div className="text-xs text-ink-3 mt-0.5">
        Cancelled or marked Won&apos;t renew, counted once each by the reason picked.
      </div>
      {total === 0 ? (
        <p className="mt-4 text-sm text-ink-3">No customer has left in the last 12 months.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {counts.map((r) => (
            <li key={r.code} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 text-sm" data-testid={`leave-reason-${r.code}`}>
              <span className={r.code === "unrecorded" ? "text-ink-3" : "text-ink"}>{r.label}</span>
              <span className="h-2 rounded-full bg-paper-2 overflow-hidden" aria-hidden>
                <span className={`block h-full rounded-full ${r.code === "unrecorded" ? "bg-ink-4" : "bg-amber"}`} style={{ width: `${r.pct}%` }} />
              </span>
              <span className="tabular-nums text-ink-2">{r.count} <span className="text-ink-3">({r.pct}%)</span></span>
            </li>
          ))}
        </ul>
      )}
      {total > 0 && (
        <p className="mt-3 text-2xs text-ink-3">{total} left in total. “Not recorded” = left before the reason list existed.</p>
      )}
    </Card>
  );
}

export function LeaveReasonsCard() {
  const q = useLeavers();
  if (q.isLoading || q.isError || !q.data) return null;   // the page's own load/error states cover the page; this card just waits
  return <LeaveReasonsView rows={q.data} />;
}
