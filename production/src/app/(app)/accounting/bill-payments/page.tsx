/**
 * Payments Made — every rupee that left the bank, the mirror of Payments Received:
 * vendors & expenses, salaries, statutory & tax challans, advances & commissions,
 * capital / loans — from the reconciled bank lines (lib/accounting/payments-made.ts).
 * Read-only; money is recorded where it happens (Bills, Expenses, Payroll, Banking).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useMoneyOut } from "@/lib/queries/payments-made";
import { summarisePaidOut, paidOutCsvRows, PAID_OUT_CSV_HEADERS, GROUP_LABEL, paymentEditHref, type PaidGroup } from "@/lib/accounting/payments-made";
import { istToday } from "@/lib/dates/ist";

type Tab = "all" | PaidGroup;
const TABS: Tab[] = ["all", "vendors", "salaries", "statutory", "advances", "other", "unreconciled"];
function todayIso(): string { return istToday(); }

export default function PaymentsMadePage() {
  const { data, isLoading, error } = useMoneyOut();
  const router = useRouter();
  /* One filter, not seven tabs (2 Oct 2026, Pardeep: "isko ek hi me kar do") — the tab row ran
     off the screen after the third tab. In the URL, so a link can open one group. */
  const [tab, setTab] = useUrlChoice<Tab>("type", TABS, "all");
  /* R-287: search in the URL next to ?type, so Back / reload keeps the filtered list. */
  const [q, setQ] = useUrlState("q");
  /* Analytics card folds like the one on Payments Received; the choice is remembered per browser. */
  const [analyticsOpen, setAnalyticsOpen] = React.useState(true);
  React.useEffect(() => { try { setAnalyticsOpen(localStorage.getItem("ros.paymentsMade.analytics") !== "closed"); } catch { /* private mode */ } }, []);
  const toggleAnalytics = () => setAnalyticsOpen((v) => { try { localStorage.setItem("ros.paymentsMade.analytics", v ? "closed" : "open"); } catch { /* ignore */ } return !v; });
  const lines = React.useMemo(() => data ?? [], [data]);
  const summary = React.useMemo(() => summarisePaidOut(lines, todayIso()), [lines]);
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines
      .filter((l) => tab === "all" || l.group === tab)
      .filter((l) => !needle || [l.payee, l.what, l.reference ?? "", l.description ?? "", l.account].some((s) => s.toLowerCase().includes(needle)));
  }, [lines, tab, q]);
  const shown = rows.reduce((s, l) => s + l.amount, 0);
  const countOf = (g: Tab) => (g === "all" ? lines.length : lines.filter((l) => l.group === g).length);

  const exportCsv = () => downloadCSV(`payments-made-${tab}-${todayIso()}.csv`, PAID_OUT_CSV_HEADERS, paidOutCsvRows(rows));

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-5 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Payments Made</h1>
          <p className="text-sm text-ink-3 mt-1">Every rupee that left the bank — vendors, salaries, tax challans, advances · from bank lines, as reconciled</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" icon="download" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
          <Link href={"/accounting/bills" as Route}><Button variant="primary" icon="file">View Bills →</Button></Link>
        </div>
      </div>


      {/* Analytics strip — the mirror of "Payments & Collections Analytics" */}
      {!isLoading && lines.length > 0 && (
        <Card className="mb-4 p-3 md:p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-semibold text-ink-2 font-mono">
              Payments &amp; Outflow Analytics
              {!analyticsOpen && <span className="font-normal text-ink-3"> · Paid MTD: <b className="text-rose">{rupee(summary.mtd)}</b> · This FY: <b className="text-ink">{rupee(summary.fy)}</b> · Awaiting reconcile: {summary.unreconciled.count}</span>}
            </p>
            <button type="button" onClick={toggleAnalytics} aria-expanded={analyticsOpen} className="text-xs font-semibold text-amber-ink hover:underline inline-flex items-center gap-1">
              {analyticsOpen ? "Collapse" : "Expand"} <Icon name={analyticsOpen ? "chevron_up" : "chevron_down"} size={13} />
            </button>
          </div>
          {analyticsOpen && (<>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid MTD</p><p className="font-serif text-2xl text-rose mt-1">{rupee(summary.mtd)}</p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid this FY</p><p className="font-serif text-2xl text-ink mt-1">{rupee(summary.fy)}</p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Awaiting reconcile</p><p className={`font-serif text-2xl mt-1 ${summary.unreconciled.count ? "text-amber-ink" : "text-emerald"}`}>{rupee(summary.unreconciled.amount)} <span className="text-xs font-sans text-ink-3">({summary.unreconciled.count})</span></p></div>
            <div className="rounded-md border border-hairline p-3"><p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Top payee</p><p className="font-serif text-lg text-ink mt-1 truncate">{summary.topPayee ? `${summary.topPayee.name}` : "—"}</p>{summary.topPayee && <p className="text-xs text-ink-3">{rupee(summary.topPayee.amount)} all-time</p>}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
            {/* Each group is also the filter — one click shows that group's payments. */}
            {summary.byGroup.map((g) => (
              <button key={g.group} type="button" onClick={() => setTab(g.group)} aria-pressed={tab === g.group}
                className={"rounded px-1 -mx-1 hover:bg-paper-2 " + (tab === g.group ? "bg-amber-soft/50 text-ink" : "")}>
                {g.label} <b className="text-ink-2">{rupee(g.amount)}</b> ({g.count})
              </button>
            ))}
          </div>
          </>)}
        </Card>
      )}

      {/* Tabs + search stay pinned under the top bar (h-14) while the list scrolls. */}
      <div className="sticky top-14 z-20 -mx-4 md:-mx-6 lg:-mx-8 px-4 md:px-6 lg:px-8 pt-2 pb-1 bg-paper/95 backdrop-blur-sm border-b border-hairline">
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
        <label className="inline-flex items-center gap-2 text-sm text-ink-2">
          <span className="text-ink-3">Show</span>
          <select
            aria-label="Payment type"
            value={tab}
            onChange={(e) => setTab(e.target.value as Tab)}
            className="rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            {TABS.map((t) => {
              const n = countOf(t);
              if (t !== "all" && n === 0) return null;
              return <option key={t} value={t}>{t === "all" ? "All payments" : GROUP_LABEL[t]} ({n})</option>;
            })}
          </select>
        </label>
        <p className="text-sm text-ink-3">Showing {rows.length} of {lines.length} payments · <b className="text-ink">{rupee(shown)}</b>{tab === "all" ? ` · ${rupee(summary.allTime)} paid all-time` : ""}</p>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Payee, what, bill no., narration…" className="w-full sm:w-80" aria-label="Search payments" />
      </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : error ? (
        <Card><p className="text-sm text-rose">Couldn&apos;t load payments. Please refresh.</p></Card>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon="rupee" title={lines.length ? "Nothing matches this filter or search" : "No payments yet"} body="Import a bank statement and reconcile its lines — every money-out will show here." /></Card>
      ) : (
        <>
          <ul className="md:hidden space-y-2">
            {rows.map((l) => (
              <li key={l.id}>
                {/* The whole card opens the payment's record (paymentEditHref). */}
                <Link href={paymentEditHref(l) as Route} className="block rounded-lg border border-hairline bg-paper p-3 hover:border-amber/60">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink truncate">{l.payee}</span>
                  <span className="font-serif tabular-nums text-rose">− {rupee(l.amount)}</span>
                </div>
                <div className="mt-1 text-xs text-ink-3">{formatDate(l.txn_date)} · {l.what}{l.reference ? ` · ${l.reference}` : ""} · {l.account}</div>
                {l.group === "unreconciled" && <span className="text-xs text-amber-ink underline">Reconcile →</span>}
                </Link>
              </li>
            ))}
          </ul>
          <Card className="hidden md:block p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr className="text-left text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                    <th className="p-3">Date</th><th className="p-3">Paid to</th><th className="p-3">What</th><th className="p-3">Ref</th><th className="p-3">Paid from</th><th className="p-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id} onClick={() => router.push(paymentEditHref(l) as Route)}
                      className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer" title="Open this payment">
                      <td className="p-3 whitespace-nowrap text-ink-2">{formatDate(l.txn_date)}</td>
                      <td className="p-3 font-medium text-ink">
                        {/* A real link too, for keyboard and new-tab users; the row click is the shortcut. */}
                        <Link href={paymentEditHref(l) as Route} onClick={(e) => e.stopPropagation()} className="hover:underline">{l.payee}</Link>
                      </td>
                      <td className="p-3 text-ink-2">{l.group === "unreconciled" ? <span className="text-amber-ink underline">Not reconciled — book it →</span> : l.what}</td>
                      <td className="p-3 font-mono text-xs text-ink-3">{l.reference ?? "—"}</td>
                      <td className="p-3 text-ink-2">{l.account}</td>
                      <td className="p-3 text-right font-serif tabular-nums text-rose">− {rupee(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
