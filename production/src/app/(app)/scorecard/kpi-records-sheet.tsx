/**
 * R-2965 — the records behind one Scorecards KPI, in a right-side Sheet.
 *
 * The rows are `row.records` — the SAME lists `buildPerfRows` counted for the tile
 * (lib/performance/kpi-records.ts), so the number in the header is the tile's number and the
 * list adds up to it. Nothing is re-read per row: the only extra read is the customers'
 * names for the payments listed, in one request, and only while a payments Sheet is open.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { downloadCSV } from "@/lib/csv";
import { formatIstDate, formatIstTime, formatMonthLabel } from "@/lib/dates/ist";
import { paymentDocHref, paymentDocId } from "@/lib/payments/payment-source";
import { num, rupee } from "@/lib/utils";
import { taskHref } from "../tasks/overview/overview-counts";
import {
  KPI_LABEL, daysLate, emptyReason, kpiValue, summariseActivity, wonOutsideWindow,
  type AttendanceIn, type KpiKey, type LeadIn, type PaymentIn, type PerfRow, type QuoteIn, type TaskIn,
} from "@/lib/performance/kpi-records";

/** The tile's text for a KPI — the tile and the Sheet header both use it. */
export function kpiDisplay(row: PerfRow, kpi: KpiKey): string {
  const v = kpiValue(row, kpi);
  return kpi === "revenue" ? rupee(v, { compact: true }) : num(v);
}

/** Exact rupees with paise, so the listed amounts add up to the header to the paisa. */
export const exactRupee = (n: number) => rupee(n, { decimals: 2 });

const dateOf = (iso: string | null | undefined) => (iso ? formatIstDate(iso) : "—");

/* One column = header, sort key, cell, and its CSV value. */
interface Col<T> extends DataTableColumn<T> { csv: (row: T) => string | number }

function useCustomerNames(ids: readonly (string | null | undefined)[], enabled: boolean) {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ["scorecard-kpi-customers", key.join(",")],
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const supabase = createClient();
      const rows = await fetchAllRowsIn(key, (chunk, from, to) =>
        supabase.from("customers").select("id, name").in("id", chunk).order("id", { ascending: true }).range(from, to));
      return new Map(rows.map((c) => [c.id, c.name]));
    },
  });
}

function paymentCols(names: Map<string, string> | undefined): Col<PaymentIn>[] {
  const customer = (p: PaymentIn) => (p.customer_id ? names?.get(p.customer_id) ?? "" : "");
  return [
    { id: "date", header: "Received", width: "18%", sortValue: (p) => p.received_at, cell: (p) => dateOf(p.received_at), csv: (p) => dateOf(p.received_at) },
    { id: "customer", header: "Customer", width: "30%", sortValue: (p) => customer(p) || null, cell: (p) => customer(p) || <span className="text-ink-3">—</span>, csv: customer },
    {
      id: "doc", header: "Quote / invoice", width: "24%", sortValue: (p) => paymentDocId(p) || null,
      cell: (p) => paymentDocId(p)
        ? <Link className="text-amber-ink hover:underline" href={paymentDocHref(p) as Route}>{paymentDocId(p)}</Link>
        : <span className="text-ink-3">—</span>,
      csv: (p) => paymentDocId(p),
    },
    { id: "method", header: "Method", width: "12%", sortValue: (p) => p.method ?? null, cell: (p) => p.method ?? "—", csv: (p) => p.method ?? "" },
    { id: "amount", header: "Amount", width: "16%", align: "right", sortValue: (p) => p.amount ?? 0, cell: (p) => <span className="tabular-nums">{exactRupee(p.amount ?? 0)}</span>, csv: (p) => p.amount ?? 0 },
  ];
}

function leadCols(period: string, monthLabel: string): Col<LeadIn>[] {
  const name = (l: LeadIn) => l.company || l.contact_name || "Lead";
  return [
    { id: "lead", header: "Lead", width: "36%", sortValue: (l) => name(l), cell: (l) => <Link className="text-amber-ink hover:underline" href={`/leads?lead=${encodeURIComponent(l.id)}`}>{name(l)}</Link>, csv: name },
    { id: "value", header: "Value", width: "18%", align: "right", sortValue: (l) => l.value ?? 0, cell: (l) => <span className="tabular-nums">{rupee(l.value ?? 0)}</span>, csv: (l) => l.value ?? 0 },
    {
      id: "won", header: "Won on", width: "46%", sortValue: (l) => l.stage_changed_at ?? null,
      cell: (l) => (
        <span>
          {dateOf(l.stage_changed_at)}
          {wonOutsideWindow(l, period) && (
            <span className="block text-2xs text-amber-ink">Won earlier — counted because it was edited in {monthLabel} ({dateOf(l.updated_at)})</span>
          )}
        </span>
      ),
      csv: (l) => dateOf(l.stage_changed_at),
    },
  ];
}

const quoteCols: Col<QuoteIn>[] = [
  { id: "quote", header: "Quote", width: "22%", sortValue: (q) => q.id, cell: (q) => <Link className="text-amber-ink hover:underline" href={`/quotes/${encodeURIComponent(q.id)}`}>{q.id}</Link>, csv: (q) => q.id },
  { id: "customer", header: "Customer", width: "30%", sortValue: (q) => q.customer_name ?? null, cell: (q) => q.customer_name || <span className="text-ink-3">—</span>, csv: (q) => q.customer_name ?? "" },
  { id: "created", header: "Created", width: "16%", sortValue: (q) => q.created_at, cell: (q) => dateOf(q.created_at), csv: (q) => dateOf(q.created_at) },
  { id: "status", header: "Status", width: "16%", sortValue: (q) => q.status ?? null, cell: (q) => <span>{q.status ?? "—"}{q.is_renewal ? <span className="block text-2xs text-ink-3">Renewal</span> : null}</span>, csv: (q) => `${q.status ?? ""}${q.is_renewal ? " (renewal)" : ""}` },
  { id: "amount", header: "Amount", width: "16%", align: "right", sortValue: (q) => q.amount ?? 0, cell: (q) => <span className="tabular-nums">{rupee(q.amount ?? 0)}</span>, csv: (q) => q.amount ?? 0 },
];

function attendanceCols(employeeId: string | null, period: string): Col<AttendanceIn>[] {
  const href = `/accounting/attendance?employee=${encodeURIComponent(employeeId ?? "")}&month=${encodeURIComponent(period)}` as Route;
  return [
    { id: "date", header: "Date", width: "50%", sortValue: (a) => a.work_date, cell: (a) => <Link className="text-amber-ink hover:underline" href={href}>{dateOf(a.work_date)}</Link>, csv: (a) => dateOf(a.work_date) },
    { id: "in", header: "Check-in", width: "50%", sortValue: (a) => a.check_in ?? null, cell: (a) => formatIstTime(a.check_in) || "—", csv: (a) => formatIstTime(a.check_in) },
  ];
}

function taskCols(late: boolean): Col<TaskIn>[] {
  const cols: Col<TaskIn>[] = [
    { id: "task", header: "Task", width: late ? "40%" : "50%", sortValue: (t) => t.title ?? null, cell: (t) => <Link className="text-amber-ink hover:underline" href={taskHref(t.id) as Route}>{t.title || "Task"}</Link>, csv: (t) => t.title ?? "" },
    { id: "due", header: "Due", width: "22%", sortValue: (t) => t.due_at ?? null, cell: (t) => dateOf(t.due_at), csv: (t) => dateOf(t.due_at) },
    { id: "done", header: "Completed", width: late ? "22%" : "28%", sortValue: (t) => t.completed_at ?? null, cell: (t) => dateOf(t.completed_at), csv: (t) => dateOf(t.completed_at) },
  ];
  if (late) {
    cols.push({
      id: "late", header: "Days late", width: "16%", align: "right", sortValue: (t) => daysLate(t),
      cell: (t) => { const d = daysLate(t); return d === null ? "—" : d === 0 ? "Same day" : <span className="tabular-nums">{d}</span>; },
      csv: (t) => daysLate(t) ?? "",
    });
  }
  return cols;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "person";
}

/** A list of records with sort + CSV. */
function RecordList<T>({ rows, cols, rowId, noun, empty, csvName }: {
  rows: T[]; cols: Col<T>[]; rowId: (r: T) => string; noun: string; empty: string; csvName: string;
}) {
  const exportCsv = () => downloadCSV(csvName, cols.map((c) => String(c.header)), rows.map((r) => cols.map((c) => c.csv(r))));
  return (
    <DataTable
      rows={rows}
      columns={cols}
      getRowId={rowId}
      noun={noun}
      pageSize={100}
      toolbar={rows.length > 0 ? <Button size="sm" icon="download" onClick={exportCsv}>Export CSV</Button> : null}
      empty={<EmptyState compact icon="inbox" title="Nothing to list" body={empty} />}
      mobileCard={(r) => (
        <div className="rounded-lg border border-hairline p-3 text-sm space-y-0.5">
          {cols.map((c) => (
            <div key={c.id} className="flex justify-between gap-3">
              <span className="text-ink-3 text-2xs uppercase tracking-wider">{c.header}</span>
              <span className="text-right min-w-0 break-words">{c.cell?.(r)}</span>
            </div>
          ))}
        </div>
      )}
    />
  );
}

function ActivityBreakdown({ row, monthLabel, csvName }: { row: PerfRow; monthLabel: string; csvName: string }) {
  const s = React.useMemo(() => summariseActivity(row.records?.activity ?? []), [row.records]);
  if (s.total === 0) {
    return <EmptyState compact icon="inbox" title="Nothing to list" body={emptyReason("activity", row.name, monthLabel)} />;
  }
  const lines: { key: string; label: string; count: number }[] = [
    ...s.top,
    ...(s.other.count > 0 ? [{ key: "__other", label: `Other (${s.other.types} types)`, count: s.other.count }] : []),
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        <b className="tabular-nums">{s.total.toLocaleString("en-IN")}</b> changes in {monthLabel}:{" "}
        <b className="tabular-nums">{s.ownCount.toLocaleString("en-IN")}</b> one at a time, and{" "}
        <b className="tabular-nums">{s.bulkCount.toLocaleString("en-IN")}</b> written in bulk ({s.bulkRuns} {s.bulkRuns === 1 ? "operation" : "operations"} that changed many rows at once — an import, a bulk edit, or follow-on updates one click caused).
      </p>
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">By type (top 10)</h3>
          <Button size="sm" icon="download" onClick={() => downloadCSV(csvName, ["Type", "Count"], lines.map((l) => [l.label, l.count]))}>Export CSV</Button>
        </div>
        <table className="w-full text-sm" aria-label="Activity by type">
          <thead><tr className="border-b border-hairline text-2xs uppercase tracking-wider text-ink-3"><th className="text-left py-1.5 font-semibold">Type</th><th className="text-right py-1.5 font-semibold">Count</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="border-b border-hairline last:border-0"><td className="py-1.5">{l.label}</td><td className="py-1.5 text-right tabular-nums">{num(l.count)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.bulkCount > 0 && (
        <div>
          <h3 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Written in bulk (automatic / many rows at once)</h3>
          <table className="w-full text-sm" aria-label="Bulk changes by type">
            <tbody>
              {s.bulkTop.map((t) => (
                <tr key={t.key} className="border-b border-hairline last:border-0"><td className="py-1.5">{t.label}</td><td className="py-1.5 text-right tabular-nums">{t.count.toLocaleString("en-IN")}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-2xs text-ink-3">
        Activity counts every row this login changed (the audit log). It is a signal only, not part of the score.{" "}
        <Link className="text-amber-ink hover:underline" href="/activity">Open the Activity Log</Link>
      </p>
    </div>
  );
}

const NOTE: Partial<Record<KpiKey, string>> = {
  revenue: "Payments marked received that this person recorded (Recorded by), by the date received.",
  payments: "Payments marked received that this person recorded (Recorded by), by the date received.",
  dealsWon: "Leads this person owns that are Won and were last edited this month.",
  quotes: "Quotes this person owns, created this month (renewal quotes included).",
  present: "Days with a check-in, for the employee linked to this login.",
  tasksOnTime: "Done tasks this person owns, completed on or before the due time.",
  tasksLate: "Done tasks this person owns, completed after the due time. Days late counts calendar days (IST); \"Same day\" = late by hours on the due day.",
};

export function KpiRecordsSheet({ row, kpi, period, onOpenChange }: {
  row: PerfRow | null;
  kpi: KpiKey | null;
  /** 'YYYY-MM' */
  period: string;
  onOpenChange: (open: boolean) => void;
}) {
  const open = !!row && !!kpi;
  const rec = row?.records;
  const isPay = kpi === "revenue" || kpi === "payments";
  const names = useCustomerNames(isPay ? (rec?.payments ?? []).map((p) => p.customer_id) : [], open && isPay);
  const monthLabel = formatMonthLabel(period, { month: "long" });
  const csvName = row && kpi ? `scorecard-${slug(KPI_LABEL[kpi])}-${slug(row.name)}-${period}.csv` : "scorecard.csv";

  let body: React.ReactNode = null;
  if (row && kpi && rec) {
    const why = emptyReason(kpi, row.name, monthLabel, { employeeLinked: !!rec.employeeId });
    switch (kpi) {
      case "revenue":
      case "payments":
        body = <RecordList rows={rec.payments} cols={paymentCols(names.data)} rowId={(p) => p.id} noun="payment" empty={why} csvName={csvName} />;
        break;
      case "dealsWon":
        body = <RecordList rows={rec.dealsWon} cols={leadCols(period, monthLabel)} rowId={(l) => l.id} noun="lead" empty={why} csvName={csvName} />;
        break;
      case "quotes":
        body = <RecordList rows={rec.quotes} cols={quoteCols} rowId={(q) => q.id} noun="quote" empty={why} csvName={csvName} />;
        break;
      case "present":
        body = <RecordList rows={rec.present} cols={attendanceCols(rec.employeeId, period)} rowId={(a) => a.id ?? a.work_date} noun="day" empty={why} csvName={csvName} />;
        break;
      case "tasksOnTime":
        body = <RecordList rows={rec.tasksOnTime} cols={taskCols(false)} rowId={(t) => t.id} noun="task" empty={why} csvName={csvName} />;
        break;
      case "tasksLate":
        body = <RecordList rows={rec.tasksLate} cols={taskCols(true)} rowId={(t) => t.id} noun="task" empty={why} csvName={csvName} />;
        break;
      case "activity":
        body = <ActivityBreakdown row={row} monthLabel={monthLabel} csvName={csvName} />;
        break;
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[640px] md:max-w-[760px] p-0 flex flex-col overflow-x-hidden" data-testid="kpi-records-sheet">
        {row && kpi && (
          <>
            <SheetHeader>
              <SheetTitle>{KPI_LABEL[kpi]} — {row.name}</SheetTitle>
              <SheetDescription>
                {monthLabel} · <b data-testid="kpi-sheet-value" className="text-ink font-serif text-lg tabular-nums">{kpiDisplay(row, kpi)}</b>
                {kpi === "revenue" && <span data-testid="kpi-sheet-exact" className="tabular-nums"> ({exactRupee(row.revenue)})</span>}
                {NOTE[kpi] && <span className="block text-2xs mt-1">{NOTE[kpi]}</span>}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 pb-6">{body}</div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
