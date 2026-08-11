/**
 * Accounting Overview — the money cockpit.
 *
 * One "am I okay?" screen: current cash, what's owed to you, what you owe, GST
 * due — plus a "needs attention" worklist (actionable nudges only) and a jump-to
 * hub for the statements. Every figure reuses the same hooks the detail pages use
 * (useBalanceSheetAuto etc.), so nothing here can disagree with those pages.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import { useBalanceSheetAuto } from "@/lib/queries/balance-sheet";
import { useOutstandingPayable, useUnreconciledExpenses } from "@/lib/queries/expenses";
import { useBankAccounts } from "@/lib/queries/bank";

type Tone = "emerald" | "rose" | "amber" | "indigo" | "ink";

export default function AccountingOverviewPage() {
  const autoQ = useBalanceSheetAuto();
  const payableQ = useOutstandingPayable();
  const unrecQ = useUnreconciledExpenses();
  const accountsQ = useBankAccounts();

  // Data-integrity: a cash account can't be negative in reality.
  const negativeCash = (accountsQ.data ?? []).filter(
    (a) => a.account_type === "cash" && (a.current_balance ?? a.opening_balance) < 0,
  );

  const a = autoQ.data;
  const loading = autoQ.isLoading;

  const cash = a?.cashAndBank ?? 0;
  const owedToYou = a ? a.receivables + a.projectReceivable + a.tdsReceivable + a.employeeLoans : 0;
  const youOwe = a
    ? a.payables + a.salaryPayable + a.salaryDuesPayable + a.reimbursementsPayable +
      a.creditCardPayable + a.emiLoansPayable + a.businessLoansPayable
    : 0;
  const gstDue = a?.gstPayable ?? 0;
  const fyLabel = a?.fyLabel ?? "";

  // Needs-attention worklist — only actionable items surface.
  const nudges: { icon: string; tone: Tone; title: string; amount?: number; href: string; cta: string }[] = [];
  if (negativeCash.length > 0) nudges.push({ icon: "alert", tone: "rose", title: `${negativeCash.length === 1 ? negativeCash[0].name : `${negativeCash.length} cash accounts`} showing negative — a deposit is likely unrecorded`, href: "/accounting/banking", cta: "Fix cash" });
  if (gstDue > 0) nudges.push({ icon: "file", tone: "rose", title: `GST net payable · ${fyLabel}`, amount: gstDue, href: "/accounting/gst", cta: "Review GST" });
  if ((payableQ.data?.count ?? 0) > 0) nudges.push({ icon: "clock", tone: "amber", title: `${payableQ.data!.count} bill${payableQ.data!.count === 1 ? "" : "s"} / expense${payableQ.data!.count === 1 ? "" : "s"} to pay`, amount: payableQ.data!.amount, href: "/accounting/expenses", cta: "Pay / settle" });
  if (owedToYou > 0) nudges.push({ icon: "rupee", tone: "amber", title: "To collect from customers", amount: owedToYou, href: "/accounting/aging", cta: "Chase" });
  if ((unrecQ.data?.length ?? 0) > 0) nudges.push({ icon: "refresh", tone: "indigo", title: `${unrecQ.data!.length} paid item${unrecQ.data!.length === 1 ? "" : "s"} awaiting bank match`, href: "/accounting/banking", cta: "Reconcile" });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Overview</h1>
        <p className="text-sm text-ink-2 mt-1">Your business&apos;s money health, right now — and what needs your attention.</p>
      </div>

      {/* Hero — the four numbers that matter */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <HeroKpi label="Cash & bank" value={cash} tone={cash < 0 ? "rose" : "emerald"} loading={loading}
          hint="Money you actually have" href="/accounting/banking" />
        <HeroKpi label="Owed to you" value={owedToYou} tone="amber" loading={loading}
          hint="Receivables + advances" href="/accounting/aging" />
        <HeroKpi label="You owe" value={youOwe} tone={youOwe > 0 ? "rose" : "ink"} loading={loading}
          hint="Payables, salary, loans, GST-side" href="/accounting/expenses" />
        <HeroKpi label={`GST due · ${fyLabel}`} value={gstDue} tone={gstDue > 0 ? "rose" : "emerald"} loading={loading}
          hint="Net output − input, before filing" href="/accounting/gst" />
      </div>

      {/* Needs attention */}
      <Card className="mb-5 p-0 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-hairline flex items-center gap-2">
          <Icon name="alert" size={15} className="text-amber-ink" />
          <h2 className="font-medium text-ink text-sm">Needs your attention</h2>
        </div>
        {loading ? (
          <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : nudges.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="inline-flex items-center gap-2 text-emerald font-medium">
              <Icon name="check_circle" size={18} /> All clear — nothing needs action right now.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {nudges.map((n) => (
              <li key={n.title}>
                <Link href={n.href as never} className="flex items-center gap-3 px-4 py-3 hover:bg-paper-2/50 transition-colors">
                  <span className={`grid place-items-center w-8 h-8 rounded-full shrink-0 ${toneBg(n.tone)}`}>
                    <Icon name={n.icon} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink truncate">{n.title}</span>
                    {n.amount != null && <span className={`block text-[12px] font-mono ${toneText(n.tone)}`}>{rupee(n.amount)}</span>}
                  </span>
                  <span className="text-[12px] text-amber-ink font-medium inline-flex items-center gap-1 shrink-0">
                    {n.cta} <Icon name="arrow_right" size={13} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Jump to — the hub */}
      <h2 className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">Reports &amp; ledgers</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <JumpCard href="/accounting/pnl" icon="trending_up" title="P&L Report" sub="Revenue − costs = profit" />
        <JumpCard href="/accounting/balance-sheet" icon="layout" title="Balance Sheet" sub="What you own vs owe" />
        <JumpCard href="/accounting/cash-flow" icon="rupee" title="Cash Flow" sub="Real money in vs out" />
        <JumpCard href="/accounting/banking" icon="rupee" title="Banking" sub="Accounts + reconcile" />
        <JumpCard href="/accounting/gst" icon="file" title="GST Reports" sub="Output − input + filing" />
        <JumpCard href="/accounting/profitability" icon="users" title="Customer Margin" sub="Profit per customer" />
        <JumpCard href="/accounting/aging" icon="clock" title="Customer Aging" sub="Who owes, how old" />
        <JumpCard href="/accounting/tds-receivable" icon="rupee" title="TDS Receivable" sub="TDS credits to claim" />
        <JumpCard href="/accounting/assets" icon="cart" title="Assets & EMIs" sub="Fixed assets + loans" />
        <JumpCard href="/accounting/business-loans" icon="rupee" title="Business Loans" sub="Borrowings + EMIs" />
        <JumpCard href="/accounting/saas-metrics" icon="sparkles" title="SaaS Metrics" sub="MRR · churn · LTV" />
      </div>
    </div>
  );
}

function toneBg(t: Tone) {
  return t === "rose" ? "bg-rose/10 text-rose"
    : t === "amber" ? "bg-amber-soft text-amber-ink"
    : t === "indigo" ? "bg-indigo/10 text-indigo"
    : t === "emerald" ? "bg-emerald/10 text-emerald"
    : "bg-paper-2 text-ink-2";
}
function toneText(t: Tone) {
  return t === "rose" ? "text-rose" : t === "amber" ? "text-amber-ink" : t === "indigo" ? "text-indigo" : t === "emerald" ? "text-emerald" : "text-ink-2";
}

function HeroKpi({ label, value, tone, hint, href, loading }: {
  label: string; value: number; tone: Tone; hint: string; href: string; loading: boolean;
}) {
  return (
    <Link href={href as never}>
      <Card className="p-3.5 h-full hover:border-hairline-strong transition-colors group">
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1 truncate">{label}</div>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className={`font-serif text-2xl md:text-[28px] leading-none ${toneText(tone)}`}>{rupee(value)}</div>
        )}
        <div className="text-[11px] text-ink-3 mt-1.5 flex items-center gap-1">
          {hint}
          <Icon name="arrow_right" size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </Card>
    </Link>
  );
}

function JumpCard({ href, icon, title, sub }: { href: string; icon: string; title: string; sub: string }) {
  return (
    <Link href={href as never}>
      <Card className="p-3.5 h-full hover:border-hairline-strong transition-colors group">
        <div className="flex items-center gap-2 mb-1">
          <Icon name={icon} size={15} className="text-amber-ink shrink-0" />
          <span className="font-medium text-ink text-[13px] truncate">{title}</span>
        </div>
        <div className="text-[11px] text-ink-3 leading-snug">{sub}</div>
      </Card>
    </Link>
  );
}
