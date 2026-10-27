/**
 * R-1872 — Accounting → Advances → "Advance register": per employee, everything handed over
 * (given), what their bills used (spent), what came back (returned), what is still with them
 * (balance) and for how long (days outstanding). Filter "Open > 30 days"; CSV for the CA.
 * Pure numbers from lib/accounting/employee-advance.ts#advanceRegister.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { downloadCSV } from "@/lib/csv";
import {
  advanceRegister, isOverdueAdvance, REGISTER_CSV_HEADERS, registerCsvRows, type RegisterAdvance,
} from "@/lib/accounting/employee-advance";

export function AdvanceRegister({ advances }: { advances: readonly RegisterAdvance[] }) {
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const today = istToday();
  const all = React.useMemo(() => advanceRegister(advances, today), [advances, today]);
  const rows = overdueOnly ? all.filter(isOverdueAdvance) : all;
  const overdueCount = all.filter(isOverdueAdvance).length;

  if (all.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby="advance-register-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="advance-register-title" className="font-serif text-xl">Advance register</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-hairline p-0.5" role="group" aria-label="Filter the register">
            <button type="button" aria-pressed={!overdueOnly} onClick={() => setOverdueOnly(false)}
              className={`rounded px-2.5 py-1 text-xs ${!overdueOnly ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}>All</button>
            <button type="button" aria-pressed={overdueOnly} onClick={() => setOverdueOnly(true)}
              className={`rounded px-2.5 py-1 text-xs ${overdueOnly ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}>Open &gt; 30 days ({overdueCount})</button>
          </div>
          <Button size="sm" variant="outline" icon="download"
            onClick={() => downloadCSV(`advance-register-${today}.csv`, REGISTER_CSV_HEADERS, registerCsvRows(rows))}>
            Export CSV
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">No advance has been out for more than 30 days.</p>
      ) : (
        <div className="rounded-lg border border-hairline overflow-hidden">
          <table className="w-full text-sm">
            <thead className="hidden sm:table-header-group bg-paper-2/60 text-2xs uppercase tracking-wider text-ink-3">
              <tr>
                <th scope="col" className="text-left font-semibold px-3 py-2">Employee</th>
                <th scope="col" className="text-right font-semibold px-3 py-2">Given</th>
                <th scope="col" className="text-right font-semibold px-3 py-2">Spent (bills)</th>
                <th scope="col" className="text-right font-semibold px-3 py-2">Returned</th>
                <th scope="col" className="text-right font-semibold px-3 py-2">Balance</th>
                <th scope="col" className="text-right font-semibold px-3 py-2">Days out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee} className="border-t border-hairline grid grid-cols-2 gap-x-3 px-3 py-2 sm:table-row sm:p-0">
                  <th scope="row" className="col-span-2 text-left font-semibold text-ink sm:px-3 sm:py-2">{r.employee}</th>
                  <td className="text-xs text-ink-3 sm:text-sm sm:text-ink sm:text-right sm:px-3 sm:py-2 tabular-nums"><span className="sm:hidden">Given </span>{rupee(r.given)}</td>
                  <td className="text-xs text-ink-3 sm:text-sm sm:text-ink sm:text-right sm:px-3 sm:py-2 tabular-nums"><span className="sm:hidden">Spent </span>{rupee(r.spent)}</td>
                  <td className="text-xs text-ink-3 sm:text-sm sm:text-ink sm:text-right sm:px-3 sm:py-2 tabular-nums"><span className="sm:hidden">Returned </span>{rupee(r.returned)}</td>
                  <td className={`text-xs sm:text-sm sm:text-right sm:px-3 sm:py-2 tabular-nums font-semibold ${r.balance > 0 ? "text-amber-ink" : "text-ink-2"}`}><span className="sm:hidden font-normal">Balance </span>{rupee(r.balance)}</td>
                  <td className={`col-span-2 text-xs sm:text-sm sm:text-right sm:px-3 sm:py-2 tabular-nums ${isOverdueAdvance(r) ? "text-rose font-semibold" : "text-ink-2"}`}>
                    <span className="sm:hidden">Days out </span>{r.ageDays == null ? "—" : r.ageDays}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
