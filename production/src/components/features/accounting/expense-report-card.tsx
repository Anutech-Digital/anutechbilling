/**
 * ExpenseReportCard — the P&L's operating expenses by vendor, and month by month when the
 * period spans more than one.
 *
 * R-1833 (24 Oct 2026): the categories now sit inside the P&L statement itself, under
 * "Operating expenses" (each one opens its entries), so this card no longer repeats them on
 * screen — it shows only what the statement does not: vendors and months. Its CSV still
 * carries categories, vendors and months, as a complete expense report.
 *
 * Totals come from lib/accounting/expense-report.ts over the same rows as the P&L's
 * "Operating expenses" line, so the two can never disagree.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { formatMonthLabel } from "@/lib/dates/ist";
import { downloadCSV } from "@/lib/csv";
import type { ExpenseReport } from "@/lib/accounting/expense-report";

interface Props {
  report: ExpenseReport;
  periodLabel: string;          // "2026-09-01 to 2026-09-30"
  fileStem: string;             // for the CSV name
  /** ₹ of these rows the P&L shows under cost of goods (salary on projects) — lib/accounting/project-cost.ts. */
  movedToCogs?: number;
}

const monthLabel = (ym: string) => formatMonthLabel(ym, { year: "2-digit" });

export function ExpenseReportCard({ report, periodLabel, fileStem, movedToCogs = 0 }: Props) {
  const [showAllVendors, setShowAllVendors] = React.useState(false);
  const maxMonth = Math.max(1, ...report.byMonth.map((m) => m.total));
  const vendors = showAllVendors ? report.byVendor : report.byVendor.slice(0, 8);

  const exportCsv = () => {
    downloadCSV(
      `expense-report-${fileStem}.csv`,
      ["Section", "Name", "Amount (INR)", "Entries", "Share %"],
      [
        ["Period", periodLabel, "", "", ""],
        ["Total", "", report.total, report.count, 100],
        ...report.byCategory.map((c): [string, string, number, number, number] => ["Category", c.category, c.total, c.count, c.pct]),
        ...report.byVendor.map((v): [string, string, number, number, string] => ["Vendor", v.vendor, v.total, v.count, ""]),
        ...report.byMonth.map((m): [string, string, number, number, string] => ["Month", m.month, m.total, m.count, ""]),
      ],
    );
  };

  return (
    <Card className="p-5 md:p-6 mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Expense report · vendors and months</h2>
          <p className="font-serif text-2xl text-ink mt-1 tabular-nums">{rupee(report.total)}</p>
          <p className="text-xs text-ink-3">
            {report.count} {report.count === 1 ? "entry" : "entries"} · {periodLabel} · {movedToCogs > 0
              ? <>every booked expense, GST included — {rupee(movedToCogs)} of it (salary on projects) is shown under cost of goods. Categories are in the statement above.</>
              : <>every booked expense, GST included. Categories are in the statement above.</>}
          </p>
        </div>
        <Button icon="download" variant="ghost" onClick={exportCsv} disabled={report.count === 0}>Export CSV</Button>
      </div>

      {report.count === 0 ? (
        <p className="text-sm text-ink-3">No expenses booked in this period.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* By vendor */}
          <section>
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Top vendors</h3>
            <ul className="divide-y divide-hairline">
              {vendors.map((v) => (
                <li key={v.vendor} className="flex items-baseline justify-between gap-2 py-1.5 text-[13px]">
                  <span className="text-ink-2 truncate">
                    {v.vendor} <span className="text-xs text-ink-3">· {v.count}</span>
                  </span>
                  <span className="tabular-nums text-ink shrink-0">{rupee(v.total)}</span>
                </li>
              ))}
            </ul>
            {report.byVendor.length > 8 && (
              <button type="button" onClick={() => setShowAllVendors((s) => !s)} className="mt-1 text-xs text-amber-ink hover:underline">
                {showAllVendors ? "Show top 8" : `Show all ${report.byVendor.length}`}
              </button>
            )}
          </section>

          {/* By month — only when there is more than one to compare */}
          {report.byMonth.length > 1 && (
            <section>
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Month by month</h3>
              <ul className="space-y-1">
                {report.byMonth.map((m) => (
                  <li key={m.month} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-[13px]">
                    <span className="text-ink-3 text-xs">{monthLabel(m.month)}</span>
                    <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
                      <div className="h-full rounded-full bg-rose/60" style={{ width: `${Math.max(2, Math.round((m.total / maxMonth) * 100))}%` }} />
                    </div>
                    <span className="tabular-nums text-ink">{rupee(m.total)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}
