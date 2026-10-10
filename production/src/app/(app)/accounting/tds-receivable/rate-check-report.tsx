"use client";
/**
 * R-523 — owner report: TDS entries whose rate does not fit their section.
 *
 * The Record payment drawer left the rate at 10% when the section was switched 194J →
 * 194C, so some past entries carry a rate their section does not have. Past entries are
 * NEVER changed here — this only lists them so the owner (with the CA) can check each
 * against the customer's Form 16A. Rates come from the one table, lib/accounting/tds-rates.ts.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { useTdsReceivables, type TdsReceivable } from "@/lib/queries/tds-receivable";
import { tdsRateMismatches } from "@/lib/accounting/tds-receipt";

export function TdsRateCheckReport({ onOpen }: { onOpen?: (row: TdsReceivable) => void }) {
  // Every year, every status — a wrong rate matters until the ITR is filed.
  const q = useTdsReceivables();
  const mismatches = React.useMemo(() => tdsRateMismatches(q.data ?? []), [q.data]);
  const [open, setOpen] = React.useState(false);
  if (!q.data || mismatches.length === 0) return null;
  const firm = mismatches.filter((m) => !m.knownVariant).length;

  return (
    <Card className="mb-5 p-4 border-amber/40" data-testid="tds-rate-check-report">
      <button
        type="button"
        className="w-full flex items-start justify-between gap-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-start gap-2">
          <Icon name="alert" size={16} className="text-amber-ink mt-0.5 flex-shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-ink">
              {mismatches.length} TDS {mismatches.length === 1 ? "entry has" : "entries have"} a rate that is not the section&apos;s usual rate
            </span>
            <span className="block text-xs text-ink-3 mt-0.5">
              {firm > 0 ? `${firm} look wrong · ` : ""}Check each against the customer&apos;s Form 16A. Nothing here is changed automatically.
            </span>
          </span>
        </span>
        <Icon name={open ? "chevron_up" : "chevron_down"} size={16} className="text-ink-3 flex-shrink-0 mt-0.5" />
      </button>
      {open && (
        <ul className="mt-3 divide-y divide-hairline">
          {mismatches.map(({ entry, defaultPct, knownVariant, message }) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onOpen?.(entry)}
                className="w-full text-left py-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 hover:bg-paper-2/50 rounded-sm px-1"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium text-ink">{entry.customer_name}</span>
                  <span className="text-xs text-ink-3"> · {formatDate(entry.payment_received_date)}</span>
                  <span className="block text-xs text-ink-3 mt-0.5">{message}</span>
                </span>
                <span className="flex items-center gap-2 text-xs tabular-nums">
                  <Badge kind={knownVariant ? "warning" : "danger"}>
                    {entry.section} @ {Number(entry.rate_pct)}% (usual {defaultPct}%)
                  </Badge>
                  <span className="font-mono">{rupee(entry.tds_amount)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
