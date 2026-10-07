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
import { useBankAccounts } from "@/lib/queries/bank";
import { Icon } from "@/components/ui/icon";
import { CashFlowMonthSheet } from "@/components/features/accounting/cash-flow-month-sheet";
import { cashFlowByActivity } from "@/lib/accounting/cash-flow-lines";
import { loadCashFlow, type CashFlowData } from "./load";
import { monthRows, runway as computeRunway, type MonthRow } from "@/lib/accounting/cash-flow-summary";
import { utcDateISO } from "@/lib/dates/ist";

type RangeKey = "month" | "fy" | "12m" | "all";

function fyStart(d: Date): Date {
  const y = d.getUTCFullYear();
  return new Date(Date.UTC(d.getUTCMonth() >= 3 ? y : y - 1, 3, 1));
}
function rangeBounds(key: RangeKey): { from: string | null; to: string | null; label: string } {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const iso = utcDateISO;   // `now` pehle se IST-shifted hai
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
    /* Every row, past PostgREST's 1000-row cap (R-265) — cash-flow/load.ts. */
    queryFn: (): Promise<CashFlowData> => loadCashFlow(createClient(), from, to),
  });
}

export default function CashFlowPage() {
  const [range, setRange] = React.useState<RangeKey>("12m");
  const { data: flow, isLoading, error, refetch } = useCashFlow(range);
  const lines = flow?.lines;
  const { data: bsAuto } = useBalanceSheetAuto();      // current cash-in-bank
  const meta = rangeBounds(range);

  const currentCash = bsAuto?.cashAndBank ?? 0;
  /* R-179: ye page bank lines ka statement hai, isliye "Cash in bank" bank hi rehta hai. Jo
     paisa mila par abhi kisi bank line se match nahi hua, wo alag tile me — Balance Sheet ke
     "Received, not yet in bank" jaisa hi number, taaki dono pages milein. */
  const unbanked = bsAuto?.undepositedFunds ?? 0;

  /* Month drill-down: click a row → its bank lines. */
  const [openYm, setOpenYm] = React.useState<string | null>(null);
  const { data: accounts } = useBankAccounts();
  const accountName = React.useCallback(
    (id: string) => accounts?.find((a) => a.id === id)?.name ?? "Bank account",
    [accounts],
  );
  const openLines = React.useMemo(
    () => (openYm ? (lines ?? []).filter((l) => l.txn_date.startsWith(openYm)) : []),
    [lines, openYm],
  );

  /* Each month ends on the statement balance (lib/accounting/cash-flow-summary.ts). */
  const months = React.useMemo<MonthRow[]>(
    () => monthRows(lines ?? [], flow?.balanceBefore ?? 0),
    [lines, flow?.balanceBefore],
  );

  const totals = React.useMemo(() => {
    const t = months.reduce((s, r) => ({ cashIn: s.cashIn + r.cashIn, cashOut: s.cashOut + r.cashOut }), { cashIn: 0, cashOut: 0 });
    return { ...t, net: t.cashIn - t.cashOut };
  }, [months]);

  /* Runway, two ways, over every month in the span: if nothing comes in, and at the
     span's trend. The old figure averaged loss months only and dropped the receipts. */
  const runway = React.useMemo(() => computeRunway(months, currentCash), [months, currentCash]);
  const fmtMonths = (n: number) => (n >= 99 ? "99+" : n.toFixed(1));

  const maxFlow = Math.max(1, ...months.map((r) => Math.max(r.cashIn, r.cashOut)));
  const empty = !isLoading && !error && months.length === 0;

  /* Cash flow statement by activity (direct method) — lib/accounting/cash-flow-lines.ts. */
  const byActivity = React.useMemo(() => cashFlowByActivity(lines ?? []), [lines]);
  const exportCsv = () => {
    downloadCSV(
      `cash-flow-${range}.csv`,
      ["Month", "Cash in", "Cash out", "Net", "Balance (month end)"],
      [
        ...months.map((r): [string, number, number, number, number] => [monthLabel(r.ym), r.cashIn, r.cashOut, r.net, r.balanceEnd]),
        ["Total", totals.cashIn, totals.cashOut, totals.net, months.length ? months[months.length - 1].balanceEnd : 0],
        ["", "", "", "", ""],
        ["Cash flow statement (direct method)", "Cash in", "Cash out", "Net", ""],
        ...byActivity.map((g): [string, number, number, number, string] => [g.label, g.cashIn, g.cashOut, g.net, ""]),
        ["Opening cash (range start)", "", "", flow?.balanceBefore ?? 0, ""],
        ["Closing cash", "", "", months.length ? months[months.length - 1].balanceEnd : 0, ""],
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
            ...(unbanked !== 0 ? [{ label: "Received, not yet in bank", value: rupee(unbanked, { compact: true }) }] : []),
          ]}
        />
      )}

      {/* Cash flow statement by activity — what the CA's "cash flow statement" is, from the same lines. */}
      {!empty && !error && byActivity.length > 0 && (
        <Card className="mb-5 p-3.5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
            <p className="text-sm font-semibold text-ink">Cash flow statement — by activity (direct method)</p>
            <span className="text-xs text-ink-3">reconciliation se classify; transfers alag; unreconciled alag</span>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-hairline">
              {byActivity.map((g) => (
                <tr key={g.activity} className={g.activity === "transfer" || g.activity === "unreconciled" ? "text-ink-3" : ""}>
                  <td className="py-1.5 pr-3">{g.label}<span className="ml-1 text-xs text-ink-3">({g.count})</span></td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-emerald">{g.cashIn ? rupee(g.cashIn) : "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono tabular-nums text-rose">{g.cashOut ? rupee(g.cashOut) : "—"}</td>
                  <td className={`py-1.5 pl-2 text-right font-mono tabular-nums font-semibold ${g.net >= 0 ? "text-emerald" : "text-rose"}`}>{g.net < 0 ? "−" : ""}{rupee(Math.abs(g.net))}</td>
                </tr>
              ))}
              <tr className="font-semibold text-ink">
                <td className="py-1.5 pr-3">Net change in cash</td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums">{rupee(totals.cashIn)}</td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums">{rupee(totals.cashOut)}</td>
                <td className={`py-1.5 pl-2 text-right font-mono tabular-nums ${totals.net >= 0 ? "text-emerald" : "text-rose"}`}>{totals.net < 0 ? "−" : ""}{rupee(Math.abs(totals.net))}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-3">Opening cash {rupee(flow?.balanceBefore ?? 0)} → closing {rupee(months.length ? months[months.length - 1].balanceEnd : 0)}. Indirect method (net profit ± working capital) ke liye P&amp;L aur Balance Sheet — ye direct method hai, jo chhoti company ke liye CA aksar yahi maangta hai.</p>
        </Card>
      )}

      {/* Runway callout */}
      {!empty && !error && runway != null && (() => {
        const tight = runway.atTrend !== null && runway.atTrend < 3;
        const watch = runway.atTrend !== null && runway.atTrend < 6;
        return (
          <Card className={`mb-5 p-3.5 ${tight ? "border-rose/40 bg-rose/5" : watch ? "border-amber/30 bg-amber-soft/20" : ""}`}>
            <p className="text-sm text-ink-2 mb-2">
              <b>Bank mein {rupee(currentCash)}</b> — kitne din chalega? (pichhle {runway.months} mahine ke hisaab se)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Agar ab koi paisa na aaye</div>
                <div className="font-serif text-2xl text-ink tabular-nums">
                  {runway.ifNoIncome === null ? "—" : <>≈ {fmtMonths(runway.ifNoIncome)} mahine</>}
                </div>
                <div className="text-xs text-ink-3">average kharcha {rupee(runway.spendPerMonth)}/mahina</div>
              </div>
              <div>
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Pichhle {runway.months} mahine jaisa chale</div>
                <div className={`font-serif text-2xl tabular-nums ${tight ? "text-rose" : "text-ink"}`}>
                  {runway.atTrend === null ? "Paisa badh raha hai" : <>≈ {fmtMonths(runway.atTrend)} mahine</>}
                </div>
                <div className="text-xs text-ink-3">
                  {runway.netPerMonth < 0
                    ? <>income ke baad bhi average {rupee(-runway.netPerMonth)}/mahina ghat raha hai</>
                    : <>average {rupee(runway.netPerMonth)}/mahina badh raha hai</>}
                </div>
              </div>
            </div>
            {tight && <p className="text-xs text-rose mt-2">Tight — receivables jaldi collect karo ya non-essential kharcha roko.</p>}
          </Card>
        );
      })()}

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
                  <th className="text-left  px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Month</th>
                  <th className="text-left  px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider w-[38%]">In vs out</th>
                  <th className="text-right px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Cash in</th>
                  <th className="text-right px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Cash out</th>
                  <th className="text-right px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Net</th>
                  <th className="text-right px-3 py-2.5 text-3xs font-semibold text-ink-3 uppercase tracking-wider" title="Opening balance + every line up to the month end — what the statement shows">Balance (month end)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {months.map((r) => (
                  <tr
                    key={r.ym}
                    onClick={() => setOpenYm(r.ym)}
                    className="hover:bg-paper-2/40 cursor-pointer"
                    title="Click to see this month's bank lines"
                  >
                    <td className="px-3 py-2.5 font-medium text-ink whitespace-nowrap">
                      {/* The keyboard route into the drill-down; the row click is a convenience. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setOpenYm(r.ym); }}
                        className="inline-flex items-center gap-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                        aria-label={`Show bank lines for ${monthLabel(r.ym)}`}
                      >
                        {monthLabel(r.ym)}
                        <Icon name="chevron_right" size={13} className="text-ink-3" />
                      </button>
                    </td>
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
                    <td className={`px-3 py-2.5 text-right tabular-nums ${r.balanceEnd < 0 ? "text-rose" : "text-ink"}`}>
                      {r.balanceEnd < 0 ? "−" : ""}{rupee(Math.abs(r.balanceEnd))}
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
                  <td className="px-3 py-2.5 text-right tabular-nums">{months.length ? rupee(months[months.length - 1].balanceEnd) : ""}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <CashFlowMonthSheet
        open={openYm !== null}
        onOpenChange={(o) => { if (!o) setOpenYm(null); }}
        monthLabel={openYm ? monthLabel(openYm) : ""}
        lines={openLines}
        accountName={accountName}
      />

      <p className="text-xs text-ink-3 mt-3 leading-relaxed">
        Click a month to see the bank lines behind it.{" "}
        Cash flow = actual bank credits (in) minus debits (out) per month, from your imported/connected statements.
        Balance (month end) = opening balance + every line up to that month — it should match your statement.
        This is different from Profit (P&amp;L), which counts invoices whether or not the cash has arrived.
      </p>
    </div>
  );
}
