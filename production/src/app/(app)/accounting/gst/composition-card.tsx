"use client";

/**
 * R-1530: Accounting → GST — "Composition scheme" card. Quarter by quarter: composition
 * Bills of Supply, credit/debit notes, turnover × composition rate = tax the business pays
 * itself (CMP-08), and the year's GSTR-4 total. Shown when the business is on composition
 * today, or had composition bills in the chosen year (it switched back to registered).
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadErrorInline } from "@/components/shared/load-error";
import { rupee, formatDate } from "@/lib/utils";
import { fyStartYear, istToday } from "@/lib/dates/ist";
import { useGstRegistration } from "@/lib/compliance/gst-registration-query";
import { COMPOSITION_CSV_HEADERS, compositionCsv, gstr4Year, type Gstr4 } from "@/lib/compliance/composition-return";
import { useCompositionRows } from "./composition-report";
import { downloadCSV } from "./download-csv";

export function CompositionReturnCard() {
  const reg = useGstRegistration();
  const today = istToday();
  const [year, setYear] = React.useState(() => fyStartYear(today));
  const fy = React.useMemo(() => ({ from: `${year}-04-01`, to: `${year + 1}-03-31` }), [year]);
  const onComposition = reg.data?.saved === "composition";
  const rows = useCompositionRows(fy, Boolean(reg.data) && !reg.data?.columnMissing);

  const report = React.useMemo((): { ok: Gstr4 } | { error: string } | null => {
    if (!rows.data || !reg.data) return null;
    try {
      return { ok: gstr4Year({ docs: rows.data.docs, notes: rows.data.notes, rate: reg.data.compositionRate, fyStartYear: year }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [rows.data, reg.data, year]);

  if (!reg.data || reg.data.columnMissing) return null;
  // Not on composition and no composition bills this year — nothing to file, no card.
  if (!onComposition && (!rows.data || rows.data.docs.length === 0)) return null;

  const y = report && "ok" in report ? report.ok : null;
  const thisYear = fyStartYear(today);

  return (
    <Card className="mb-6 p-4 md:p-5 border border-amber/30" aria-labelledby="composition-title">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-3 mb-3">
        <div>
          <h2 id="composition-title" className="font-serif text-xl text-ink leading-tight">
            Composition scheme — CMP-08 &amp; GSTR-4
          </h2>
          <p className="text-xs text-ink-3 mt-1 max-w-2xl leading-relaxed">
            Your Bills of Supply carry no GST. You pay {y ? `${y.rate}%` : "the composition rate"} of
            each quarter&apos;s sales yourself (half CGST, half SGST) with CMP-08 by the 18th after the
            quarter, and file GSTR-4 once a year. Not collected from customers.{" "}
            <Link href="/settings?tab=company" className="text-amber-ink underline underline-offset-2">Change the rate</Link>
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="ghost" size="sm" icon="chevron-left" aria-label="Previous year" onClick={() => setYear((v) => v - 1)} />
          <span className="text-sm font-medium tabular-nums min-w-[6.5rem] text-center">FY {year}-{String((year + 1) % 100).padStart(2, "0")}</span>
          <Button variant="ghost" size="sm" icon="chevron-right" aria-label="Next year" disabled={year >= thisYear} onClick={() => setYear((v) => v + 1)} />
          <Button
            variant="default" size="sm" icon="download" disabled={!y}
            onClick={() => y && downloadCSV(`composition-cmp08-gstr4-${y.fyLabel.replace(/\W+/g, "-").toLowerCase()}.csv`, [...COMPOSITION_CSV_HEADERS], compositionCsv(y))}
          >
            CSV
          </Button>
        </div>
      </div>

      {rows.isError ? (
        <LoadErrorInline what="Composition report" error={rows.error} onRetry={() => void rows.refetch()} />
      ) : report && "error" in report ? (
        <p role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-sm text-ink">{report.error}</p>
      ) : !y ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums" aria-label={`CMP-08 quarters and GSTR-4 total, ${y.fyLabel}`}>
            <thead className="text-3xs uppercase tracking-wider text-ink-3">
              <tr className="border-b border-hairline">
                <th scope="col" className="text-left font-semibold py-1.5 pr-3">Return</th>
                <th scope="col" className="text-right font-semibold px-2">Bills</th>
                <th scope="col" className="text-right font-semibold px-2">Sales</th>
                <th scope="col" className="text-right font-semibold px-2">Credit / debit notes</th>
                <th scope="col" className="text-right font-semibold px-2">Turnover</th>
                <th scope="col" className="text-right font-semibold px-2">CGST</th>
                <th scope="col" className="text-right font-semibold px-2">SGST</th>
                <th scope="col" className="text-right font-semibold px-2">Tax to pay</th>
                <th scope="col" className="text-right font-semibold pl-2">Due</th>
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {y.quarters.map((q) => {
                const current = today >= q.from && today <= q.to;
                const notes = q.debitNotes - q.creditNotes;
                return (
                  <tr key={q.key} className={`border-b border-hairline/60 ${current ? "bg-amber-soft/30" : ""}`}>
                    <th scope="row" className="text-left font-medium text-ink py-1.5 pr-3 whitespace-nowrap">
                      CMP-08 {q.key} <span className="text-ink-3 font-normal">· {q.label}</span>
                      {current && <span className="ml-1.5 text-3xs uppercase tracking-wider text-amber-ink">running</span>}
                    </th>
                    <td className="text-right px-2">{q.bills}</td>
                    <td className="text-right px-2">{rupee(q.grossTurnover)}</td>
                    <td className="text-right px-2">{notes === 0 ? "—" : `${notes > 0 ? "+" : "−"} ${rupee(Math.abs(notes))}`}</td>
                    <td className="text-right px-2">{rupee(q.netTurnover)}</td>
                    <td className="text-right px-2">{rupee(q.cgst)}</td>
                    <td className="text-right px-2">{rupee(q.sgst)}</td>
                    <td className="text-right px-2 font-semibold text-ink">{rupee(q.tax)}</td>
                    <td className="text-right pl-2 whitespace-nowrap">{formatDate(q.due)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold text-ink">
                <th scope="row" className="text-left py-2 pr-3 whitespace-nowrap">GSTR-4 · {y.fyLabel}</th>
                <td className="text-right px-2">{y.bills}</td>
                <td className="text-right px-2">{rupee(y.grossTurnover)}</td>
                <td className="text-right px-2">{y.debitNotes - y.creditNotes === 0 ? "—" : `${y.debitNotes > y.creditNotes ? "+" : "−"} ${rupee(Math.abs(y.debitNotes - y.creditNotes))}`}</td>
                <td className="text-right px-2">{rupee(y.netTurnover)}</td>
                <td className="text-right px-2">{rupee(y.cgst)}</td>
                <td className="text-right px-2">{rupee(y.sgst)}</td>
                <td className="text-right px-2">{rupee(y.tax)}</td>
                <td className="text-right pl-2 whitespace-nowrap">{formatDate(y.due)}</td>
              </tr>
            </tfoot>
          </table>
          {y.bills === 0 && (
            <p className="text-xs text-ink-3 mt-2">No composition Bills of Supply in {y.fyLabel} yet — CMP-08 is still filed (as nil) every quarter.</p>
          )}
        </div>
      )}
    </Card>
  );
}
