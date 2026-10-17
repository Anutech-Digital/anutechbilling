/**
 * R-1517 — one customer's follow-up history: newest first, who / when / kind / note / promise.
 * A promise whose date has passed while money is still owed is shown red ("Promise broken").
 * Order and the broken flag come from buildFollowupHistory (lib/collections/followup-rules).
 */
"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { formatDate, rupee } from "@/lib/utils";
import { formatIstDate, formatIstTime } from "@/lib/dates/ist";
import type { UserName } from "@/lib/hooks/useUserNames";
import { FOLLOWUP_KIND_LABEL, type FollowupHistoryEntry, type FollowupKind } from "@/lib/collections/followup-rules";

const kindLabel = (k: string) => FOLLOWUP_KIND_LABEL[k as FollowupKind] ?? k;

export function FollowupHistory({
  entries, names, isLoading, isError, onRetry, limit,
}: {
  entries: readonly FollowupHistoryEntry[];
  names: Map<string, UserName> | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onRetry: () => void;
  /** Show only the newest N, with a "Show all" button. */
  limit?: number;
}) {
  const [all, setAll] = React.useState(false);
  if (isLoading) return <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (isError) return <LoadError what="Follow-up history" onRetry={onRetry} />;
  if (entries.length === 0) {
    return <p className="text-sm text-ink-3 py-3">No follow-ups yet. The first call, message or promise you log shows here.</p>;
  }
  const who = (id: string | null) => (id ? names?.get(id)?.label ?? "a colleague" : "—");
  const shown = limit && !all ? entries.slice(0, limit) : entries;

  return (
    <div>
      <ol className="space-y-2.5" aria-label="Follow-up history, newest first">
        {shown.map((e) => (
          <li
            key={e.id}
            className={`rounded-md border px-3 py-2.5 text-sm ${e.broken ? "border-rose/40 bg-rose-soft/40" : "border-hairline bg-paper"}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge kind={e.kind === "promise" ? "info" : "muted"}>{kindLabel(e.kind)}</Badge>
              <span className="text-ink-2">{who(e.created_by)}</span>
              <span className="text-ink-3 text-xs tabular-nums">
                {formatIstDate(e.created_at)} · {formatIstTime(e.created_at)}
              </span>
              {e.broken && <Badge kind="danger" dot>Promise broken</Badge>}
            </div>
            {e.note && <p className="mt-1.5 text-ink break-words whitespace-pre-line">{e.note}</p>}
            <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-3">
              {e.promised_on && (
                <div className={e.broken ? "text-rose font-medium" : undefined}>
                  <dt className="inline">Promised: </dt>
                  <dd className="inline tabular-nums">
                    {e.promised_amount != null && e.promised_amount > 0 ? `${rupee(e.promised_amount)} by ` : "Pay by "}
                    {formatDate(e.promised_on)}
                    {e.broken && " — date passed, still owed"}
                  </dd>
                </div>
              )}
              {e.next_follow_up_on && (
                <div><dt className="inline">Next follow-up: </dt><dd className="inline tabular-nums">{formatDate(e.next_follow_up_on)}</dd></div>
              )}
              <div><dt className="inline">With: </dt><dd className="inline">{who(e.assigned_to)}</dd></div>
              {(e.invoice_id || e.subscription_id || e.quote_id) && (
                <div>
                  <dt className="inline">About: </dt>
                  <dd className="inline font-mono">{e.invoice_id ?? (e.subscription_id ? "Subscription" : null) ?? `Quote ${e.quote_id}`}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ol>
      {limit && entries.length > limit && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-2 min-h-[44px] md:min-h-0 px-3 py-1.5 rounded-full border border-hairline text-sm text-ink hover:border-amber/60"
        >
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}
    </div>
  );
}
