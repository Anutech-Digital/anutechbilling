/**
 * Purchases report — where the company's money goes on buying.
 *
 * Auto-aggregated (read-only) from two sources, no manual entry:
 *   • expenses      — OPEX / office buys (Amazon, rent, software, …)  → amount (ex-GST) + gst_paid
 *   • vendor_bills  — COGS (products resold)                          → subtotal (ex-GST) + cgst+sgst+igst
 *
 * All stored amounts are already in ₹ (base); foreign bills keep their ₹ value,
 * so no FX pass is needed here. We roll them up by vendor, by category and by
 * month, over a chosen date range, and surface GST input credit separately.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { StatStrip } from "@/components/shared/stat-strip";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

type RangeKey = "month" | "fy" | "12m" | "all";

interface PurchaseLine {
  id:       string;
  source:   "expense" | "cogs";
  date:     string;       // YYYY-MM-DD
  vendor:   string;
  category: string;
  net:      number;       // ex-GST ₹
  gst:      number;       // ₹ (input credit)
}

interface Agg { key: string; net: number; gst: number; gross: number; count: number }

/** Indian fiscal year start (Apr 1) for the date containing `d`. */
function fyStart(d: Date): Date {
  const y = d.getUTCFullYear();
  const fy = d.getUTCMonth() >= 3 ? y : y - 1;  // Jan-Mar belong to previous FY
  return new Date(Date.UTC(fy, 3, 1));
}

function rangeBounds(key: RangeKey): { from: string | null; to: string | null; label: string } {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const todayIso = iso(now);
  if (key === "month") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: iso(from), to: todayIso, label: "This month" };
  }
  if (key === "fy")  return { from: iso(fyStart(now)), to: todayIso, label: "This financial year" };
  if (key === "12m") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    return { from: iso(from), to: todayIso, label: "Last 12 months" };
  }
  return { from: null, to: null, label: "All time" };
}

function usePurchases(range: RangeKey) {
  const { from, to } = rangeBounds(range);
  return useQuery({
    queryKey: ["reports", "purchases", { from, to }],
    queryFn: async (): Promise<PurchaseLine[]> => {
      const supabase = createClient();
      let ex = supabase.from("expenses").select("id, expense_date, amount, gst_paid, category, vendor_name");
      let bi = supabase.from("vendor_bills").select("id, bill_date, subtotal, cgst, sgst, igst, category, vendor_name");
      if (from) { ex = ex.gte("expense_date", from); bi = bi.gte("bill_date", from); }
      if (to)   { ex = ex.lte("expense_date", to);   bi = bi.lte("bill_date", to); }
      const [exRes, biRes] = await Promise.all([ex, bi]);
      if (exRes.error) throw exRes.error;
      if (biRes.error) throw biRes.error;

      const lines: PurchaseLine[] = [];
      for (const e of exRes.data ?? []) {
        // Salaries are payroll, not a "purchase" — exclude so the report reflects
        // real buying (Amazon, software, hosting, supplies) and isn't dominated
        // by salary payouts.
        if ((e.category || "").toLowerCase() === "salaries") continue;
        lines.push({
          id: e.id,
          source: "expense",
          date: e.expense_date,
          vendor: (e.vendor_name ?? "").trim() || "—",
          category: e.category || "Other",
          net: e.amount ?? 0,
          gst: e.gst_paid ?? 0,
        });
      }
      for (const b of biRes.data ?? []) {
        lines.push({
          id: b.id,
          source: "cogs",
          date: b.bill_date,
          vendor: (b.vendor_name ?? "").trim() || "—",
          category: b.category || "COGS-Other",
          net: b.subtotal ?? 0,
          gst: (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0),
        });
      }
      return lines;
    },
  });
}

function groupBy(lines: PurchaseLine[], keyOf: (l: PurchaseLine) => string): Agg[] {
  const m = new Map<string, Agg>();
  for (const l of lines) {
    const key = keyOf(l);
    const a = m.get(key) ?? { key, net: 0, gst: 0, gross: 0, count: 0 };
    a.net += l.net; a.gst += l.gst; a.gross += l.net + l.gst; a.count += 1;
    m.set(key, a);
  }
  return Array.from(m.values()).sort((x, y) => y.gross - x.gross);
}

/** Same grouping, but keep each group's individual lines (newest first) for drill-down. */
function groupLines(lines: PurchaseLine[], keyOf: (l: PurchaseLine) => string): Map<string, PurchaseLine[]> {
  const m = new Map<string, PurchaseLine[]>();
  for (const l of lines) {
    const key = keyOf(l);
    const arr = m.get(key) ?? [];
    arr.push(l);
    m.set(key, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => b.date.localeCompare(a.date));
  return m;
}

/** Where a purchase line's source record lives — pre-filtered by vendor where possible. */
function lineHref(l: PurchaseLine): string {
  return l.source === "expense"
    ? `/accounting/expenses?q=${encodeURIComponent(l.vendor === "—" ? "" : l.vendor)}`
    : `/accounting/bills`;
}

const MONTH_LABEL = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
};

export default function PurchasesReportPage() {
  const [range, setRange] = React.useState<RangeKey>("fy");
  const { data: lines, isLoading, error, refetch } = usePurchases(range);
  const meta = rangeBounds(range);

  const byVendor  = React.useMemo(() => groupBy(lines ?? [], (l) => l.vendor), [lines]);
  const byCategory = React.useMemo(() => groupBy(lines ?? [], (l) => l.category), [lines]);
  const linesByVendor = React.useMemo(() => groupLines(lines ?? [], (l) => l.vendor), [lines]);
  const linesByCategory = React.useMemo(() => groupLines(lines ?? [], (l) => l.category), [lines]);
  const byMonth = React.useMemo(
    () => groupBy(lines ?? [], (l) => l.date.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    [lines],
  );
  const totals = React.useMemo(() => {
    const t = (lines ?? []).reduce((s, l) => ({ net: s.net + l.net, gst: s.gst + l.gst, count: s.count + 1 }), { net: 0, gst: 0, count: 0 });
    return { ...t, gross: t.net + t.gst };
  }, [lines]);

  const exportCsv = () => {
    const rows = [
      ["Purchases report", meta.label],
      [],
      ["By vendor", "Bills", "Net (ex-GST)", "GST input", "Total"],
      ...byVendor.map((v) => [v.key, v.count, v.net, v.gst, v.gross]),
      [],
      ["By category", "Bills", "Net (ex-GST)", "GST input", "Total"],
      ...byCategory.map((c) => [c.key, c.count, c.net, c.gst, c.gross]),
      [],
      ["Total", totals.count, totals.net, totals.gst, totals.gross],
    ];
    const csv = rows.map((r) => r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `purchases-${range}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const empty = !isLoading && !error && (lines?.length ?? 0) === 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            <Link href={"/reports" as never} className="hover:text-amber-ink hover:underline">Reports</Link> · Purchases
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Purchase report</h1>
          <p className="text-sm text-ink-3 mt-1">Everything the company buys — by vendor, category and month. Auto-built from your bills &amp; expenses.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button icon="download" variant="ghost" onClick={exportCsv} disabled={empty}>Export CSV</Button>
          <Button icon="file" variant="ghost" onClick={() => window.print()} disabled={empty}>Print</Button>
        </div>
      </div>

      {/* Range chips */}
      <div className="flex items-center gap-1.5 mb-5 flex-wrap">
        {([["month", "This month"], ["fy", "This FY"], ["12m", "Last 12 months"], ["all", "All time"]] as [RangeKey, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setRange(k)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              range === k ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {!empty && !error && lines && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Total purchased", value: rupee(totals.gross, { compact: true }) },
            { label: "Net (ex-GST)",    value: rupee(totals.net, { compact: true }) },
            { label: "GST input credit", value: rupee(totals.gst, { compact: true }), tone: "emerald" },
            { label: "Bills / expenses", value: String(totals.count) },
          ]}
        />
      )}

      {error && (
        <EmptyState icon="alert" title="Could not load report" body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
      )}

      {isLoading && (
        <Card flush><div className="p-4 space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div></Card>
      )}

      {empty && (
        <EmptyState
          icon="cart"
          title="No purchases in this period"
          body="Record vendor bills (COGS) or expenses — or drop a bill into Bill OCR — and this report fills in automatically."
        />
      )}

      {!isLoading && !error && lines && lines.length > 0 && (
        <div className="space-y-6">
          {/* By vendor */}
          <BreakdownTable title="By vendor" subtitle="Kisi vendor pe click karo — uski saari bills/expenses khulengi" rows={byVendor} totals={totals} firstColHeader="Vendor" groupLines={linesByVendor} />
          {/* By category */}
          <BreakdownTable title="By category" subtitle="Kisi category pe click karo — uske saare records khulenge" rows={byCategory} totals={totals} firstColHeader="Category" groupLines={linesByCategory} />

          {/* By month */}
          <Card flush>
            <div className="p-3 border-b border-hairline">
              <h2 className="text-sm font-semibold text-ink">By month</h2>
              <p className="text-[11px] text-ink-3">Spend trend over the period</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr>
                    <th className="text-left  p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Month</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Bills</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Net</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">GST</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {byMonth.map((m) => (
                    <tr key={m.key} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3 text-sm font-medium text-ink">{MONTH_LABEL(m.key)}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-2">{m.count}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-2">{rupee(m.net)}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-2">{rupee(m.gst)}</td>
                      <td className="p-3 text-right tabular-nums text-sm font-medium">{rupee(m.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL = { expense: "Expense", cogs: "COGS bill" } as const;

/** The individual purchase lines behind one vendor/category — the drill-down. */
function DrillLines({ lines, colSpan }: { lines: PurchaseLine[]; colSpan?: number }) {
  if (!lines.length) return null;
  const body = (
    <ul className="divide-y divide-hairline/70">
      {lines.map((l) => (
        <li key={`${l.source}-${l.id}`} className="flex items-center gap-3 py-2 pl-2 pr-1">
          <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${l.source === "cogs" ? "bg-indigo-soft text-indigo" : "bg-paper-2 text-ink-3"}`}>
            {SOURCE_LABEL[l.source]}
          </span>
          <span className="text-[12px] text-ink-3 tabular-nums shrink-0 w-20">{formatDate(l.date)}</span>
          <span className="text-sm text-ink-2 truncate flex-1 min-w-0">{l.category}</span>
          <span className="tabular-nums text-sm text-ink-2 shrink-0">{rupee(l.net + l.gst)}</span>
          <Link href={lineHref(l) as never} className="shrink-0 inline-flex items-center gap-0.5 text-[11px] text-amber-ink hover:underline">
            Open <Icon name="arrow_right" size={11} />
          </Link>
        </li>
      ))}
    </ul>
  );
  if (colSpan) {
    return (
      <tr className="bg-paper-2/30">
        <td colSpan={colSpan} className="px-6 py-1">{body}</td>
      </tr>
    );
  }
  return <div className="mt-2 rounded-lg bg-paper-2/40 px-2">{body}</div>;
}

/** A vendor/category rollup table (desktop) + card list (mobile), each row drills into its lines. */
function BreakdownTable({
  title, subtitle, rows, totals, firstColHeader, groupLines,
}: {
  title: string; subtitle: string; rows: Agg[]; totals: { net: number; gst: number; gross: number; count: number }; firstColHeader: string;
  groupLines: Map<string, PurchaseLine[]>;
}) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <Card flush>
      <div className="p-3 border-b border-hairline">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="text-[11px] text-ink-3">{subtitle}</p>
      </div>

      {/* Mobile cards */}
      <ul className="md:hidden divide-y divide-hairline">
        {rows.map((r) => {
          const isOpen = open.has(r.key);
          return (
            <li key={r.key} className="p-3">
              <button type="button" className="w-full text-left" onClick={() => toggle(r.key)}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-ink text-sm truncate flex items-center gap-1">
                    <Icon name={isOpen ? "chevron_down" : "chevron_up"} size={13} className="text-ink-3 rotate-90 data-[o=1]:rotate-0" data-o={isOpen ? 1 : 0} />
                    {r.key}
                  </span>
                  <span className="tabular-nums text-sm font-medium">{rupee(r.gross)}</span>
                </div>
                <div className="text-[11px] text-ink-3 tabular-nums pl-4">{r.count} bills · net {rupee(r.net)} · GST {rupee(r.gst)}</div>
              </button>
              {isOpen && <DrillLines lines={groupLines.get(r.key) ?? []} />}
            </li>
          );
        })}
      </ul>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead className="bg-paper-2 border-b border-hairline">
            <tr>
              <th className="text-left  p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">{firstColHeader}</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Bills</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Net (ex-GST)</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">GST input</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = open.has(r.key);
              return (
                <React.Fragment key={r.key}>
                  <tr className="border-b border-hairline hover:bg-paper-2/40 cursor-pointer" onClick={() => toggle(r.key)}>
                    <td className="p-3 text-sm font-medium text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name={isOpen ? "chevron_down" : "chevron_up"} size={13} className={isOpen ? "text-ink-2" : "text-ink-3 rotate-180"} />
                        {r.key}
                      </span>
                    </td>
                    <td className="p-3 text-right tabular-nums text-sm text-ink-2">{r.count}</td>
                    <td className="p-3 text-right tabular-nums text-sm text-ink-2">{rupee(r.net)}</td>
                    <td className="p-3 text-right tabular-nums text-sm text-ink-2">{rupee(r.gst)}</td>
                    <td className="p-3 text-right tabular-nums text-sm font-medium">{rupee(r.gross)}</td>
                  </tr>
                  {isOpen && <DrillLines lines={groupLines.get(r.key) ?? []} colSpan={5} />}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink bg-paper-2/40 font-semibold">
              <td className="p-3 text-sm">Total</td>
              <td className="p-3 text-right tabular-nums text-sm">{totals.count}</td>
              <td className="p-3 text-right tabular-nums text-sm">{rupee(totals.net)}</td>
              <td className="p-3 text-right tabular-nums text-sm">{rupee(totals.gst)}</td>
              <td className="p-3 text-right tabular-nums text-sm">{rupee(totals.gross)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
