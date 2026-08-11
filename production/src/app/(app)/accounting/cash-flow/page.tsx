/**
 * Cash Flow — the actual money that moved in and out of the bank, per month.
 *
 * Unlike P&L (accrual: counts an invoice as revenue even if unpaid) this reads
 * REAL bank movement from `bank_transactions` (credit = cash in, debit = cash
 * out). Answers the questions P&L can't: "profit dikh raha hai par bank khaali
 * kyun", how much runway is left, and whether the month was cash-positive.
 * Read-only, tenant-scoped by RLS.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { rupee } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { createClient } from "@/lib/supabase/client";
import { useBalanceSheetAuto } from "@/lib/queries/balance-sheet";

type RangeKey = "month" | "fy" | "12m" | "all";

interface CashLine { date: string; cashIn: number; cashOut: number }
interface MonthRow { ym: string; cashIn: number; cashOut: number; net: number; cumulative: number }

function fyStart(d: Date): Date {
  const y = d.getUTCFullYear();
  return new Date(Date.UTC(d.getUTCMonth() >= 3 ? y : y - 1, 3, 1));
}
function rangeBounds(key: RangeKey): { from: string | null; to: string | null; label: string } {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const today = iso(now);
  if (key === "month") return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: today, label: "This month" };
  if (key === "fy")    return { from: iso(fyStart(now)), to: today, label: "This financial year" };
  if (key === "12m")   return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))), to: today, label: "Last 12 months" };
  return { from: null, to: null, label: "All time" };
}
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
};

function useCashFlow(range: RangeKey) {
  const { from, to } = rangeBounds(range);
  return useQuery({
    queryKey: ["cash-flow", { from, to }],
    queryFn: async (): Promise<CashLine[]> => {
      const supabase = createClient();
      let q = supabase.from("bank_transactions").select("txn_date, debit, credit");
      if (from) q = q.gte("txn_date", from);
      if (to)   q = q.lte("txn_date", to);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((t) => ({
        date: t.txn_date, cashIn: t.credit ?? 0, cashOut: t.debit ?? 0,
      }));
    },
  });
}

export default function CashFlowPage() {
  const [range, setRange] = React.useState<RangeKey>("12m");
  const { data: lines, isLoading, error, refetch } = useCashFlow(range);
  const { data: bsAuto } = useBalanceSheetAuto();      // current cash-in-bank
  const meta = rangeBounds(range);

  const currentCash = bsAuto?.cashAndBank ?? 0;

  const months = React.useMemo<MonthRow[]>(() => {
    const m = new Map<string, { cashIn: number; cashOut: number }>();
    for (const l of lines ?? []) {
      const ym = l.date.slice(0, 7);
      const g = m.get(ym) ?? { cashIn: 0, cashOut: 0 };
      g.cashIn += l.cashIn; g.cashOut += l.cashOut;
      m.set(ym, g);
    }
    const sorted = Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let cum = 0;
    return sorted.map(([ym, g]) => {
      const net = g.cashIn - g.cashOut;
      cum += net;
      return { ym, cashIn: g.cashIn, cashOut: g.cashOut, net, cumulative: cum };
    });
  }, [lines]);

  const totals = React.useMemo(() => {
    const t = months.reduce((s, r) => ({ cashIn: s.cashIn + r.cashIn, cashOut: s.cashOut + r.cashOut }), { cashIn: 0, cashOut: 0 });
    return { ...t, net: t.cashIn - t.cashOut };
  }, [months]);

  // Runway: if the business is net-burning cash, how many months does current
  // cash last at the average monthly burn? Uses net-negative months only.
  const runway = React.useMemo(() => {
    const burnMonths = months.filter((r) => r.net < 0);
    if (burnMonths.length === 0) return null;               // not burning
    const avgBurn = burnMonths.reduce((s, r) => s + -r.net, 0) / burnMonths.length;
    if (avgBurn <= 0) return null;
    return currentCash > 0 ? currentCash / avgBurn : 0;
  }, [months, currentCash]);

  const maxFlow = Math.max(1, ...months.map((r) => Math.max(r.cashIn, r.cashOut)));
  const empty = !isLoading && !error && months.length === 0;

  const exportCsv = () => {
    downloadCSV(
      `cash-flow-${range}.csv`,
      ["Month", "Cash in", "Cash out", "Net", "Cumulative net"],
      [
        ...months.map((r): [string, number, number, number, number] => [monthLabel(r.ym), r.cashIn, r.cashOut, r.net, r.cumulative]),
        ["Total", totals.cashIn, totals.cashOut, totals.net, totals.net],
      ],
    );
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Cash Flow</h1>
          <p className="text-sm text-ink-3 mt-1">Real money in vs out of your bank — not invoices. {meta.label}.</p>
        </div>
        <Button icon="download" variant="ghost" onClick={exportCsv} disabled={empty}>Export CSV</Button>
      </div>

      {/* Range chips */}
      <div className="flex items-center gap-1.5 mb-5 flex-wrap">
        {([["month", "This month"], ["12m", "Last 12 months"], ["fy", "This FY"], ["all", "All time"]] as [RangeKey, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setRange(k)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${range === k ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2"}`}>
            {label}
          </button>
        ))}
      </div>

      {!empty && !error && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Cash in",  value: rupee(totals.cashIn, { compact: true }), tone: "emerald" },
            { label: "Cash out", value: rupee(totals.cashOut, { compact: true }), tone: "rose" },
            { label: "Net flow", value: `${totals.net < 0 ? "−" : ""}${rupee(Math.abs(totals.net), { compact: true })}`, tone: totals.net >= 0 ? "emerald" : "rose" },
            { label: "Cash in bank now", value: rupee(currentCash, { compact: true }) },
          ]}
        />
      )}

      {/* Runway callout */}
      {!empty && !error && runway != null && (
        <Card className={`mb-5 p-3.5 ${runway < 3 ? "border-rose/40 bg-rose/5" : "border-amber/30 bg-amber-soft/20"}`}>
          <p className="text-sm text-ink-2 flex items-start gap-2">
            <span className="text-lg leading-none">{runway < 3 ? "⚠️" : "🛟"}</span>
            <span>
              <b>Runway ≈ {runway >= 99 ? "99+" : runway.toFixed(1)} months</b> — at your average monthly cash burn, that&apos;s how long the current
              <b> {rupee(currentCash)}</b> in bank lasts. {runway < 3 ? "Tight — chase receivables or slow non-essential spend." : "Keep an eye on it; collect dues on time."}
            </span>
          </p>
        </Card>
      )}

      {error && (
        <EmptyState icon="alert" title="Could not load cash flow" body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
      )}
      {isLoading && <Card flush><div className="p-4 space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div></Card>}
      {empty && (
        <EmptyState icon="chart" title="No bank movement in this period"
          body="Import a bank statement (Accounting → Banking) and your monthly cash in/out will build here automatically." />
      )}

      {!isLoading && !error && months.length > 0 && (
        <Card flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left  px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">Month</th>
                  <th className="text-left  px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider w-[38%]">In vs out</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">Cash in</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">Cash out</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">Net</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">Cumulative</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {months.map((r) => (
                  <tr key={r.ym} className="hover:bg-paper-2/40">
                    <td className="px-3 py-2.5 font-medium text-ink whitespace-nowrap">{monthLabel(r.ym)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-1">
                        <div className="h-1.5 rounded-full bg-emerald/70" style={{ width: `${Math.round((r.cashIn / maxFlow) * 100)}%` }} />
                        <div className="h-1.5 rounded-full bg-rose/70" style={{ width: `${Math.round((r.cashOut / maxFlow) * 100)}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald">{rupee(r.cashIn)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{rupee(r.cashOut)}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${r.net < 0 ? "text-rose" : "text-emerald"}`}>
                      {r.net < 0 ? "−" : "+"}{rupee(Math.abs(r.net))}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${r.cumulative < 0 ? "text-rose" : "text-ink"}`}>
                      {r.cumulative < 0 ? "−" : ""}{rupee(Math.abs(r.cumulative))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink bg-paper-2/40 font-semibold">
                  <td className="px-3 py-2.5 text-sm" colSpan={2}>Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald">{rupee(totals.cashIn)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rupee(totals.cashOut)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${totals.net < 0 ? "text-rose" : "text-emerald"}`}>{totals.net < 0 ? "−" : "+"}{rupee(Math.abs(totals.net))}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <p className="text-[11px] text-ink-3 mt-3 leading-relaxed">
        Cash flow = actual bank credits (in) minus debits (out) per month, from your imported/connected statements.
        This is different from Profit (P&amp;L), which counts invoices whether or not the cash has arrived.
      </p>
    </div>
  );
}
