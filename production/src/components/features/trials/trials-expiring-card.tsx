/**
 * TrialsExpiringCard — dashboard widget for trial expiry visibility.
 *
 * Shows trials expiring in the next 7 days. Empty state celebrates
 * (no pressure today!). Each row is clickable → deep-links to the
 * lead drawer for one-click follow-up.
 *
 * Intentionally tiny — designed to sit alongside Renewals widget on
 * the morning dashboard view.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DashCardBody } from "@/components/features/dashboard/card-load-state";
import { Icon } from "@/components/ui/icon";
import { useTrialsExpiringSoon } from "@/lib/queries/trials";

export function TrialsExpiringCard() {
  const trialsQ = useTrialsExpiringSoon();
  const trials = trialsQ.data ?? [];

  /* R-2239: "No trials expiring" only once the list RESOLVED empty — a failed or slow load
     shows an error / a skeleton (+ "Still loading…" after 10 s), never the all-clear. */
  return (
    <Card title="Trials expiring soon" sub="Next 7 days · click to open lead">
      <DashCardBody queries={[trialsQ]} what="Trials" isEmpty={trials.length === 0}
        empty={
          <div className="text-xs text-ink-3 italic py-2 flex items-center gap-1.5">
            <Icon name="check_circle" size={12} className="text-emerald" />
            No trials expiring in the next 7 days.
          </div>
        }>
        <ul className="space-y-1.5">
          {trials.map((t) => {
            const dr = t.days_remaining ?? 0;
            return (
              <li key={t.id}>
                <Link
                  href={`/leads?lead=${t.id}` as never}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-paper-2/60 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink truncate">{t.company}</p>
                    {t.domain && <p className="text-3xs text-ink-3 font-mono truncate">{t.domain}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : "info"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : dr === 1 ? "1d" : `${dr}d`}
                    </Badge>
                    <p className="text-3xs text-ink-3 mt-0.5 tabular-nums">{t.seats} seats</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </DashCardBody>
    </Card>
  );
}
