/**
 * Day Book — tareekh-war har voucher (Tally ka "Day Book").
 *
 * Data `report_day_book` (migration 20260928120000) se: Sales, Receipt, Refund, Credit /
 * Debit Note, Purchase, Payment, Journal. Salary ka kharcha Journal voucher hai (Tally jaisa,
 * migration 20260929185929), uska bhugtan Payment; bank statement ki lines voucher nahi hain. Ek baar me max
 * 366 din — default is mahina.
 */
"use client";

import * as React from "react";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { localDateISO } from "@/lib/leads/outcomes";
import { monthPeriod, fyOf, fyPeriod } from "@/lib/accounting/ledger";
import { useDayBook } from "@/lib/queries/day-book";
import {
  summarizeDayBook, dayBookCsvRows, DAY_BOOK_CSV_HEADERS, DAY_BOOK_VOUCHERS, type DayBookVoucher,
} from "@/lib/accounting/day-book";

const ONLY_CHOICES: readonly (DayBookVoucher | "all")[] = ["all", ...DAY_BOOK_VOUCHERS];

const TONE: Record<DayBookVoucher, "success" | "info" | "warning" | "danger" | "muted"> = {
  Sales: "success", Receipt: "info", Refund: "warning", "Credit Note": "warning",
  "Debit Note": "muted", Purchase: "danger", Payment: "muted", Journal: "info",
};

export default function DayBookPage() {
  const today = React.useMemo(() => localDateISO(new Date()), []);
  const [y, m] = today.split("-").map(Number);
  const thisMonth = monthPeriod(y, m);
  /* R-287: range + voucher filter in the URL, so opening a voucher and pressing Back keeps them. */
  const [from, setFrom] = useUrlState("from", thisMonth.from);
  const [to, setTo]     = useUrlState("to", today);
  const range = React.useMemo(() => ({ from, to }), [from, to]);
  const [only, setOnly] = useUrlChoice<DayBookVoucher | "all">("only", ONLY_CHOICES, "all");

  const valid = !!range.from && !!range.to && range.from <= range.to;
  const q = useDayBook(range, valid);
  const all = React.useMemo(() => q.data ?? [], [q.data]);
  const rows = React.useMemo(() => (only === "all" ? all : all.filter((r) => r.voucher === only)), [all, only]);
  const summary = React.useMemo(() => summarizeDayBook(all), [all]);

  const presets: { label: string; from: string; to: string }[] = [
    { label: "Today", from: today, to: today },
    { label: "This month", from: thisMonth.from, to: today },
    { label: "This FY", from: fyPeriod(fyOf(today)).from, to: today },
  ];

  const exportCsv = () => downloadCSV(`day-book-${range.from}-to-${range.to}.csv`, DAY_BOOK_CSV_HEADERS, dayBookCsvRows(rows));

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Day Book</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Every voucher, date by date — invoices, receipts, refunds, notes, bills and payments.
            Salary expense is a Journal voucher (as in Tally) and paying it is a Payment.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {presets.map((p) => (
            <Button key={p.label} size="sm" variant={range.from === p.from && range.to === p.to ? "primary" : "default"}
              onClick={() => { setFrom(p.from); setTo(p.to); }} aria-pressed={range.from === p.from && range.to === p.to}>
              {p.label}
            </Button>
          ))}
          <Input type="date" aria-label="From" value={range.from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          <Input type="date" aria-label="To" value={range.to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          <Button size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Icon name="download" size={12} /> CSV
          </Button>
        </div>
      </div>

      {summary.byVoucher.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <Button size="sm" variant={only === "all" ? "primary" : "default"} onClick={() => setOnly("all")} aria-pressed={only === "all"}>
            All · {summary.count}
          </Button>
          {DAY_BOOK_VOUCHERS.map((v) => {
            const s = summary.byVoucher.find((x) => x.voucher === v);
            if (!s) return null;
            return (
              <Button key={v} size="sm" variant={only === v ? "primary" : "default"} onClick={() => setOnly(v)} aria-pressed={only === v}>
                {v} · {s.count} · {rupee(s.amount)}
              </Button>
            );
          })}
          <span className="text-xs text-ink-3 self-center ml-auto">
            Net cash (receipts − payments − refunds): <b className={cn(summary.netCash < 0 ? "text-rose" : "text-ink")}>{rupee(summary.netCash)}</b>
          </span>
        </div>
      )}

      {!valid ? (
        <Card className="p-4"><p className="text-sm text-ink-2">The &quot;From&quot; date must be on or before the &quot;To&quot; date.</p></Card>
      ) : q.error ? (
        <Card className="p-4 border-rose/40 bg-rose-soft/30">
          <p role="alert" className="text-sm text-ink-2">Could not build the Day Book: {(q.error as Error).message}</p>
        </Card>
      ) : q.isLoading ? (
        <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="calendar" title="No vouchers in this period" body="No invoice, receipt, bill or payment in this period. Pick another period." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-4 py-3 w-28">Date</th>
                  <th className="text-left px-4 py-3 w-32">Voucher</th>
                  <th className="text-left px-4 py-3">Reference</th>
                  <th className="text-left px-4 py-3">Party</th>
                  <th className="text-left px-4 py-3">Narration</th>
                  <th className="text-right px-4 py-3 w-36">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r, i) => (
                  <tr key={`${r.voucher}-${r.reference}-${i}`} className="hover:bg-paper-2/40">
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className="px-4 py-2"><Badge kind={TONE[r.voucher]}>{r.voucher}</Badge></td>
                    <td className="px-4 py-2 font-mono text-xs">{r.reference}</td>
                    <td className="px-4 py-2">{r.party ?? <span className="text-ink-3">—</span>}</td>
                    <td className="px-4 py-2 text-ink-3">{r.narration ?? ""}</td>
                    <td className="px-4 py-2 text-right font-mono">{rupee(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
