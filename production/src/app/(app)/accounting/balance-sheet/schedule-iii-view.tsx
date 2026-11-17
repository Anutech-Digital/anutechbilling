/**
 * R-1855 — the Schedule III (Division I) view of the Balance Sheet, for a Private Limited company.
 * Presentation only: the page passes the same figures it prints; src/lib/accounting/schedule-iii.ts
 * decides the heads. CSV and print read the same rows as this table.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { STATEMENT_ROW } from "@/components/ui/statement-row";
import { downloadCSV } from "@/lib/csv";
import { printReport } from "@/lib/reports/print";
import { formatDate } from "@/lib/utils";
import { useMsmePayables } from "@/lib/queries/day-book";
import {
  buildScheduleIII, scheduleIIICsvRows, scheduleIIITie, CSV_HEADERS, PREVIOUS_NA, UNMAPPED_LABEL,
  type ScheduleIIIInput, type ScheduleRow,
} from "@/lib/accounting/schedule-iii";
import { fmtBS } from "./format";

export type ScheduleIIIPageInput = Omit<ScheduleIIIInput, "unexplained" | "msmePayable"> & { unexplained: number | null };

export function ScheduleIIIView({ input, asOf, sheet }: {
  input: ScheduleIIIPageInput;
  asOf: string;
  /** The standard Balance Sheet's own totals — the Schedule III must tie to them. */
  sheet: { totalAssets: number; totalLiab: number; netWorth: number };
}) {
  const msmeQ = useMsmePayables();
  const msmePayable = msmeQ.data ? msmeQ.data.reduce((s, r) => s + r.amount_due, 0) : null;
  const ready = input.unexplained !== null && !msmeQ.isLoading;
  const schedule = React.useMemo(
    () => (ready ? buildScheduleIII({ ...input, unexplained: input.unexplained ?? 0, msmePayable }) : null),
    [ready, input, msmePayable],
  );
  if (!schedule) {
    return <Card className="p-6 text-sm text-ink-3" role="status">Preparing the Schedule III view…</Card>;
  }
  const tie = scheduleIIITie(schedule, sheet);
  const unexplained = schedule.rows.find((r) => r.accountKey === "unexplained_difference");
  const rows = schedule.rows;

  function exportCSV() {
    downloadCSV(`balance-sheet-schedule-iii-${asOf}.csv`, CSV_HEADERS, scheduleIIICsvRows(schedule!, asOf, null));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
        <p className="text-sm text-ink-3">
          Schedule III (Division I), Companies Act 2013 — the same Balance Sheet, grouped under the statutory heads. All amounts in ₹.
        </p>
        <div className="flex gap-2">
          <Button icon="download" onClick={exportCSV}>Export CSV</Button>
          <Button icon="printer" onClick={() => printReport(`Balance Sheet (Schedule III) as at ${asOf}`, rows.length)}>Print / Save as PDF</Button>
        </div>
      </div>

      {!tie.ties && (
        <div role="alert" className="rounded-lg border border-rose/40 bg-rose/5 px-4 py-3 text-sm text-ink">
          <b>This view does not tie to the Balance Sheet.</b> Total assets differ by {fmtBS(tie.assetsDiff)}; equity and liabilities
          differ by {fmtBS(tie.eqLiabDiff)}. An account line is missing from the Schedule III table — do not file this; tell support.
        </div>
      )}
      {schedule.unmapped.length > 0 && (
        <div role="status" className="rounded-lg border border-amber/40 bg-amber-soft/20 px-4 py-3 text-sm text-ink">
          <b>{schedule.unmapped.length === 1 ? "1 hand-entered line is" : `${schedule.unmapped.length} hand-entered lines are`} not classified yet</b> —
          shown under “{UNMAPPED_LABEL}” and counted in the totals. Ask your CA which head each belongs to.
        </div>
      )}
      {unexplained && (
        <div role="status" className="rounded-lg border border-amber/40 bg-amber-soft/20 px-4 py-3 text-sm text-ink">
          The Balance Sheet carries an unexplained difference of {fmtBS(unexplained.amount ?? 0)}; it sits under Reserves and surplus until it is resolved on the standard view.
        </div>
      )}

      <Card className="p-4 md:p-6 overflow-x-auto">
        <table className="w-full text-sm min-w-[640px] border-collapse">
          <caption className="text-left pb-3">
            <span className="block font-serif text-2xl leading-tight">Balance Sheet</span>
            <span className="block text-xs text-ink-3 mt-0.5">as at {formatDate(asOf)} · Schedule III, Division I · in ₹</span>
          </caption>
          <thead>
            <tr className="text-3xs uppercase tracking-wider text-ink-3 font-semibold border-b-2 border-ink">
              <th scope="col" className="text-left py-2 pr-3">Particulars</th>
              <th scope="col" className="text-right py-2 px-3 w-16">Note</th>
              <th scope="col" className="text-right py-2 px-3 w-40">Current period</th>
              <th scope="col" className="text-right py-2 pl-3 w-40" title="The Balance Sheet is as of today only; a previous-period figure is not available yet.">Previous period</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => <Row key={i} row={r} />)}
          </tbody>
        </table>
        <p className="text-xs text-ink-3 mt-4 leading-relaxed">
          Previous period is {PREVIOUS_NA} — the Balance Sheet is as of today; it cannot yet be read as at last year&apos;s closing date.
          Equity is the company&apos;s share capital register plus reserves (profit per P&amp;L); loans due back within 12 months are shown as current.
        </p>
      </Card>
    </div>
  );
}

function Row({ row: r }: { row: ScheduleRow }) {
  const num = "text-right tabular-nums py-1.5 px-3 whitespace-nowrap";
  if (r.kind === "section") {
    return <tr><th scope="colgroup" colSpan={4} className="text-left pt-5 pb-1 text-sm font-bold tracking-wide border-b border-hairline">{r.label}</th></tr>;
  }
  if (r.kind === "group") {
    return <tr><th scope="colgroup" colSpan={4} className="text-left pt-3 pb-1 pl-4 text-sm font-semibold">{r.label}</th></tr>;
  }
  if (r.kind === "total") {
    return (
      <tr className="border-t-2 border-ink font-bold break-inside-avoid">
        <td className="py-2 pr-3">{r.label}</td><td /><td className={num}>{fmtBS(r.amount ?? 0)}</td><td className={`${num} text-ink-3 font-normal`}>{PREVIOUS_NA}</td>
      </tr>
    );
  }
  if (r.kind === "detail") {
    return (
      <tr className={`${STATEMENT_ROW} text-ink-2 text-[13px] break-inside-avoid`}>
        <td className="py-0.5 pr-3 pl-14">{r.label}</td><td /><td className={`${num} py-0.5`}>{fmtBS(r.amount ?? 0)}</td><td />
      </tr>
    );
  }
  const unmapped = r.kind === "unmapped_head";
  return (
    <tr className={`${STATEMENT_ROW} break-inside-avoid ${unmapped ? "bg-amber-soft/30 font-semibold" : ""}`}>
      <td className="py-1.5 pr-3 pl-8"><span className="inline-block w-8 text-ink-3">{r.ref}</span>{r.label}</td>
      <td className="text-right text-ink-3 py-1.5 px-3">{r.note ?? ""}</td>
      <td className={`${num} font-medium`}>{fmtBS(r.amount ?? 0)}</td>
      <td className={`${num} text-ink-3`}>{PREVIOUS_NA}</td>
    </tr>
  );
}

/** Used by the page for the toggle's icon-free fallback note. */
export function ScheduleIIINotForType({ typeLabel }: { typeLabel: string }) {
  return (
    <p className="text-xs text-ink-3 flex items-center gap-1.5 print:hidden">
      <Icon name="info" size={13} /> Schedule III view is for Private Limited companies — your business type is {typeLabel}, so the standard Balance Sheet applies.
    </p>
  );
}
