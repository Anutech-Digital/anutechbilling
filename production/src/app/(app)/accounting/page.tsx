/**
 * Accounting Overview — the money cockpit, and now the money INBOX.
 *
 * One "am I okay?" screen: current cash, what's owed to you, what you owe, GST due —
 * then four folders of actual work, then a jump-to hub for the statements. Every figure
 * reuses the same hooks the detail pages use (useBalanceSheetAuto etc.), so nothing here
 * can disagree with those pages.
 *
 * ─── THE INBOX REPLACED A "NEEDS YOUR ATTENTION" NUDGE LIST ─────────────────
 * Not added beside it. The nudge list linked to /accounting/aging, /accounting/banking,
 * /accounting/expenses and /accounting/gst — the same four destinations the folders
 * carry. Keeping both would be two controls answering one question, which is precisely
 * the bug that produced dead filter chips on /leads: the operator cannot tell which one
 * is authoritative, so they trust neither.
 *
 * The folders say strictly more than the nudges did: a count AND a rupee figure AND why
 * it is urgent AND the action, per folder.
 *
 * ─── AND THE 28 SUB-PAGES ARE NOT TOUCHED ───────────────────────────────────
 * The brief said "consolidate fragmented accounting sub-pages into a single inbox".
 * Read literally that means deleting 14,546 lines of working payroll, loans, assets,
 * TDS and statement code. That is not what Gmail does either — Gmail's inbox is where
 * you TRIAGE, and clicking still opens the thing. So this is the triage surface and
 * those pages stay as the destinations, linked from every folder.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, rupee } from "@/lib/utils";
import { useBalanceSheetAuto } from "@/lib/queries/balance-sheet";
import { useUnreconciledExpenses, useUnpaidBillsDue } from "@/lib/queries/expenses";
import { useBankAccounts, useUnmatchedBankCredits } from "@/lib/queries/bank";
import { useInvoices } from "@/lib/queries/invoices";
import { BooksLockCard } from "@/components/features/accounting/books-lock-card";
import { GstHealthCard } from "@/components/features/accounting/gst-health-card";
import {
  MONEY_FOLDERS, moneyInboxState, totalOpenItems,
  type MoneyDirection, type MoneyFolderMeta, type MoneyFolderState,
} from "@/lib/accounting/money-inbox";
import { localDateISO } from "@/lib/leads/outcomes";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { SALARY_ROLES, type UserRole } from "@/lib/nav";

type Tone = "emerald" | "rose" | "amber" | "indigo" | "ink";

export default function AccountingOverviewPage() {
  const autoQ = useBalanceSheetAuto();
  const { data: me } = useCurrentUser();
  /* R-138: a role that cannot read salaries gets 0 for them from the database; say so rather
     than show a "You owe" that silently leaves salary and PF/ESI/TDS dues out. */
  const salaryHidden = !!me?.role && !SALARY_ROLES.includes(me.role as UserRole);
  const unrecQ = useUnreconciledExpenses();
  const accountsQ = useBankAccounts();

  /* ── The four folders ─────────────────────────────────────────────────────── */
  const invoicesQ = useInvoices();
  const creditsQ  = useUnmatchedBankCredits();
  const billsQ    = useUnpaidBillsDue();

  const today = React.useMemo(() => localDateISO(new Date()), []);
  const inbox = React.useMemo(() => {
    const todayMs = Date.parse(`${today}T00:00:00+05:30`);
    /* Receivables come from the SAME invoice statuses the dunning cron chases
       (pending / overdue), so the folder count and the reminder engine can never
       disagree about who owes money. */
    const receivables = (invoicesQ.data ?? [])
      .filter((i) => i.status === "pending" || i.status === "overdue")
      .map((i) => ({
        amountDue: Math.max(0, (i.amount ?? 0) - (i.paid_amount ?? 0)),
        daysOverdue: i.due_date
          ? Math.round((todayMs - Date.parse(`${i.due_date.slice(0, 10)}T00:00:00+05:30`)) / 86_400_000)
          : 0,
      }))
      .filter((r) => r.amountDue > 0);

    return moneyInboxState({
      receivables,
      unmatchedCredits: (creditsQ.data ?? []).map((c) => ({ amount: c.credit, daysOld: c.days_old })),
      /* daysOverdue null → 0 here means "cannot be late", which is what a bill with no
         agreed deadline is. moneyInboxState needs a number; the honest number is one
         that never trips the urgent rule. */
      billsDue: (billsQ.data ?? []).map((b) => ({
        amountDue: b.amount, daysOverdue: b.daysOverdue ?? 0,
      })),
      gstNet: autoQ.data?.gstPayable ?? 0,
    });
  }, [invoicesQ.data, creditsQ.data, billsQ.data, autoQ.data, today]);

  const inboxLoading = invoicesQ.isLoading || creditsQ.isLoading || billsQ.isLoading;

  // Data-integrity: a cash account can't be negative in reality.
  const negativeCash = (accountsQ.data ?? []).filter(
    (a) => a.account_type === "cash" && (a.current_balance ?? a.opening_balance) < 0,
  );

  const a = autoQ.data;
  const loading = autoQ.isLoading;

  /* R-179: mila hua paisa jo abhi kisi bank line se match nahi hua bhi "haath me" hai —
     Balance Sheet ke "Received, not yet in bank" jaisa hi number. */
  const unbanked = a?.undepositedFunds ?? 0;
  const cash = (a?.cashAndBank ?? 0) + unbanked;
  const owedToYou = a ? a.receivables + a.projectReceivable + a.tdsReceivable + a.employeeLoans : 0;
  const youOwe = a
    ? a.payables + a.salaryPayable + a.salaryDuesPayable + a.reimbursementsPayable +
      a.creditCardPayable + a.emiLoansPayable + a.businessLoansPayable
    : 0;
  const gstDue = a?.gstPayable ?? 0;
  const fyLabel = a?.fyLabel ?? "";

  /* The two alerts the four folders genuinely do NOT cover, kept as a thin strip above
     them rather than folded in:
       • a negative cash account is a data-integrity fault, not a folder of work
       • a paid expense awaiting its bank line is the DEBIT side of reconciliation; the
         credit side has its own folder, and merging the two would make one count mean
         two different jobs. */
  const alerts: { icon: string; tone: Tone; title: string; href: string; cta: string }[] = [];
  if (negativeCash.length > 0) alerts.push({ icon: "alert", tone: "rose", title: `${negativeCash.length === 1 ? negativeCash[0].name : `${negativeCash.length} cash accounts`} showing negative — a deposit is likely unrecorded`, href: "/accounting/banking", cta: "Fix cash" });
  if ((unrecQ.data?.length ?? 0) > 0) alerts.push({ icon: "refresh", tone: "indigo", title: `${unrecQ.data!.length} paid item${unrecQ.data!.length === 1 ? "" : "s"} awaiting their bank line`, href: "/accounting/banking", cta: "Reconcile" });

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
          hint={unbanked > 0 ? `Includes ${rupee(unbanked)} received, not yet in bank` : "Money you actually have"} href="/accounting/banking" />
        <HeroKpi label="Owed to you" value={owedToYou} tone="amber" loading={loading}
          hint="Receivables + advances" href="/accounting/aging" />
        <HeroKpi label="You owe" value={youOwe} tone={youOwe > 0 ? "rose" : "ink"} loading={loading}
          hint={salaryHidden ? "Payables, loans, GST-side · salary not shown for your role" : "Payables, salary, loans, GST-side"} href="/accounting/expenses" />
        <HeroKpi label={`GST due · ${fyLabel}`} value={gstDue} tone={gstDue > 0 ? "rose" : "emerald"} loading={loading}
          hint="Net output − input, before filing" href="/accounting/gst" />
      </div>

      <BooksLockCard />

      {/* Data-integrity + debit-side reconciliation. See the note where `alerts` is built
          for why these two are NOT folders. */}
      {alerts.length > 0 && (
        <Card className="mb-4 p-0 overflow-hidden">
          <ul className="divide-y divide-hairline">
            {alerts.map((n) => (
              <li key={n.title}>
                <Link href={n.href as Route} className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper-2/50 transition-colors">
                  <span className={`grid place-items-center w-7 h-7 rounded-full shrink-0 ${toneBg(n.tone)}`}>
                    <Icon name={n.icon} size={14} />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-ink truncate">{n.title}</span>
                  <span className="text-[12px] text-amber-ink font-medium inline-flex items-center gap-1 shrink-0">
                    {n.cta} <Icon name="arrow_right" size={13} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* GST health — placed ABOVE the money inbox because a wrong tax head is not a
          chore in a queue, it is a filing that is already wrong. The inbox is work to do;
          this is work that was done incorrectly. */}
      <GstHealthCard />

      {/* ── THE MONEY INBOX ─────────────────────────────────────────────────────
          Four folders, four different tables, four different units — so the header
          counts ROWS of work and deliberately never sums the rupees. "₹56,000 owed to
          you plus ₹12,000 you owe" is not ₹68,000, it is two numbers pointing opposite
          ways, and on a money screen a meaningless total is one somebody reports upward.
          See lib/accounting/money-inbox.ts for the full argument. */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
          Your money inbox
        </h2>
        {!inboxLoading && (
          <span className="text-xs text-ink-3 font-mono tabular-nums">
            {totalOpenItems(inbox) === 0
              ? "nothing waiting"
              : `${totalOpenItems(inbox)} thing${totalOpenItems(inbox) === 1 ? "" : "s"} waiting`}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
        {MONEY_FOLDERS.map((f) => (
          <MoneyFolderCard key={f.id} folder={f} state={inbox[f.id]} loading={inboxLoading} />
        ))}
      </div>

      {/* Jump to — the hub */}
      <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Reports &amp; ledgers</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <JumpCard href="/accounting/pnl" icon="trending_up" title="P&L Report" sub="Revenue − costs = profit" />
        <JumpCard href="/accounting/balance-sheet" icon="layout" title="Balance Sheet" sub="What you own vs owe" />
        <JumpCard href="/accounting/cash-flow" icon="rupee" title="Cash Flow" sub="Real money in vs out" />
        <JumpCard href="/accounting/banking" icon="rupee" title="Banking" sub="Accounts + reconcile" />
        <JumpCard href="/accounting/gst" icon="file" title="GST Reports" sub="Output − input + filing" />
        <JumpCard href="/accounting/profitability" icon="users" title="Customer Margin" sub="Profit per customer" />
        <JumpCard href="/accounting/aging" icon="clock" title="Customer Aging" sub="Who owes, how old" />
        <JumpCard href="/accounting/ledger" icon="file" title="Ledger (Khata)" sub="One party · Dr/Cr statement" />
        <JumpCard href="/accounting/tds-receivable" icon="rupee" title="TDS Receivable" sub="TDS credits to claim" />
        <JumpCard href="/accounting/assets" icon="cart" title="Assets & EMIs" sub="Fixed assets + loans" />
        <JumpCard href="/accounting/business-loans" icon="rupee" title="Business Loans" sub="Borrowings + EMIs" />
        <JumpCard href="/accounting/advances" icon="wallet" title="Employee Advances" sub="Petty cash + expense claims" />
        <JumpCard href="/accounting/saas-metrics" icon="sparkles" title="SaaS Metrics" sub="MRR · churn · LTV" />
      </div>
    </div>
  );
}

/**
 * One folder of the money inbox.
 *
 * The rupee figure is coloured by DIRECTION, never by size — amber for money coming in,
 * rose for money going out, ink for the government. A receivable and a payable printed in
 * the same colour is how a reseller reads their own books backwards.
 *
 * An empty folder still renders, greyed, with the sentence that says what empty MEANS
 * ("Nobody owes you money" rather than "0"). A folder that disappears when it is clear
 * reads as a missing feature, and "nothing overdue" is worth knowing.
 */
function MoneyFolderCard({ folder, state, loading }: {
  folder: MoneyFolderMeta; state: MoneyFolderState; loading: boolean;
}) {
  const empty = state.count === 0;
  return (
    <Link href={folder.href as Route} className="group">
      <Card className={cn(
        "p-3.5 h-full transition-colors",
        state.urgent ? "border-amber/50 bg-amber-soft/20" : "hover:border-hairline-strong",
      )}>
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span aria-hidden className="text-[15px] leading-none">{folder.icon}</span>
            <span className="font-medium text-ink text-[13px] truncate">{folder.label}</span>
            {state.urgent && <Badge kind="warning" size="sm">Needs action</Badge>}
          </div>
          <Icon name="arrow_right" size={13}
            className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        {loading ? <Skeleton className="h-7 w-28" /> : (
          <div className="flex items-baseline gap-2">
            <span className={cn("font-serif text-xl leading-none tabular-nums", directionText(folder.direction))}>
              {rupee(state.amount, { compact: true })}
            </span>
            {/* The noun, always. "3" tells a reseller nothing; "3 bills" tells them
                what they are looking at. Singularised by dropping the trailing s. */}
            {!empty && (
              <span className="text-xs text-ink-3 font-mono tabular-nums">
                {state.count} {state.count === 1 ? folder.noun.replace(/s$/, "") : folder.noun}
              </span>
            )}
          </div>
        )}

        <p className="mt-1.5 text-xs leading-snug text-ink-3">
          {loading ? " "
            : state.urgentReason ?? (empty ? folder.emptyHint : folder.action)}
        </p>
      </Card>
    </Link>
  );
}

/** Colour by which way the money moves — see MoneyFolderCard. */
function directionText(d: MoneyDirection) {
  return d === "in" ? "text-amber-ink" : d === "out" ? "text-rose" : "text-ink";
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
        <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1 truncate">{label}</div>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className={`font-serif text-2xl md:text-[28px] leading-none ${toneText(tone)}`}>{rupee(value)}</div>
        )}
        <div className="text-xs text-ink-3 mt-1.5 flex items-center gap-1">
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
        {/* R-180: the title wraps to a second line instead of truncating — at 800px the cards
            read "Balance Sh…", "Customer …", "Employee …". */}
        <div className="flex items-start gap-2 mb-1">
          <Icon name={icon} size={15} className="text-amber-ink shrink-0 mt-px" />
          <span className="min-w-0 font-medium text-ink text-[13px] leading-snug break-words">{title}</span>
        </div>
        <div className="text-xs text-ink-3 leading-snug">{sub}</div>
      </Card>
    </Link>
  );
}
