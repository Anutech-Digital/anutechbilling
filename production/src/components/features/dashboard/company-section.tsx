/**
 * Dashboard "Company" section — how the business is doing this month, one card per function
 * (1 Oct 2026). Owners and managers only.
 *
 * Every number is a link to the screen it sums up, and is computed by the rule that screen
 * uses — see the map at the top of lib/company/summary.ts. The rows come from the same
 * hooks those screens call, so they share the cache too.
 *
 * A source that fails shows "—" and says so. Never ₹0: a zero here reads as "no money".
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { useLeadsCreatedSince } from "@/lib/queries/leads";
import { useTrials, useActiveTrials } from "@/lib/queries/trials";
import { useDealRows } from "@/lib/queries/deals";
import { useInvoices } from "@/lib/queries/invoices";
import { usePayments } from "@/lib/queries/payments";
import { useAllProjectPayments } from "@/lib/queries/projects";
import { useCustomers } from "@/lib/queries/customers";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { summarizeDealStrip } from "@/lib/deals/pipeline-summary";
import { drillHref } from "@/lib/navigation/drilldown";
import {
  istMonthStartUtc, growthSummary, trialsStartedInMonth, invoiceMoney, collectedInMonth,
  newCustomersInMonth, subscriptionSummary, openTicketCount,
} from "@/lib/company/summary";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";

const COMPANY_ROLES = new Set(["owner", "manager"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The /support screen's own read (same endpoint, same key) — counts cover every status. */
function useTicketCounts() {
  return useQuery({
    queryKey: ["support_tickets", "tenant_feedback", "open"],
    queryFn: async (): Promise<{ counts: Record<string, number> }> => {
      const res = await fetch("/api/support/tickets?scope=tenant_feedback&status=open");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to load tickets");
      return res.json();
    },
  });
}

/** The /provisioning screen's own read (same endpoint, same key). */
function useActivationQueue() {
  return useQuery<{ counts: { waiting: number } }>({
    queryKey: ["provisioning", "queue"],
    queryFn: async () => {
      const res = await fetch("/api/provisioning/queue");
      if (!res.ok) throw new Error(`Could not load the queue (HTTP ${res.status})`);
      return res.json();
    },
    staleTime: 15_000,
  });
}

interface Q { isLoading: boolean; error: unknown }

/** One query's state, folded so a row can say loading / failed / value. */
function state(...qs: Q[]): { loading: boolean; failed: boolean } {
  return { loading: qs.some((q) => q.isLoading), failed: qs.some((q) => !!q.error) };
}

interface MetricProps {
  href: string;
  label: string;
  value: string | number | null;
  hint?: string;
  loading: boolean;
  failed: boolean;
  /** The hint line appears once the data is in; while loading, keep its line so nothing jumps (R-134). */
  withHint?: boolean;
}

function Metric({ href, label, value, hint, loading, failed, withHint }: MetricProps) {
  return (
    <Link
      href={href as Route}
      className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 -mx-2 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
    >
      <span className="min-w-0">
        <span className="block text-xs text-ink-2">{label}</span>
        {(failed || hint) && !loading && (
          <span className={failed ? "block text-3xs text-rose-ink" : "block text-3xs text-ink-3"}>
            {failed ? "Couldn't load — open the screen" : hint}
          </span>
        )}
        {loading && (hint || withHint) && <span aria-hidden className="block text-3xs">&nbsp;</span>}
      </span>
      {loading ? (
        <Skeleton className="h-4 w-12 shrink-0" />
      ) : (
        <span className="shrink-0 font-serif text-base font-semibold tabular-nums text-ink">
          {failed || value === null ? "—" : value}
        </span>
      )}
    </Link>
  );
}

function FunctionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-hairline bg-paper p-3">
      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/* While the signed-in user is still loading (role undefined) the section keeps its place as a
   skeleton of the same shape, instead of popping in later and pushing the page down (R-134:
   the UI agent measured the Dashboard's layout shift at 1.07, "poor" is anything over 0.25). */
const SHAPE: Array<[string, Array<[string, boolean]>]> = [
  ["Growth", [["Leads added", true], ["From the website", true], ["Trials started", true]]],
  ["Sales", [["Won this month", true], ["Pipeline", true]]],
  ["Money", [["Invoiced", true], ["Collected", false], ["Still owed (invoices)", true], ["Overdue invoices", false]]],
  ["Customers & Ops", [["New customers", false], ["Monthly revenue (MRR)", true], ["Renewals in 30 days", true], ["Open tickets", false], ["Waiting to activate", false]]],
];

function CompanyPending() {
  return (
    <section aria-hidden className="mb-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Company</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SHAPE.map(([title, rows]) => (
          <FunctionCard key={title} title={title}>
            {rows.map(([label, withHint]) => (
              <Metric key={label} href="#" label={label} value={null} loading failed={false} withHint={withHint} />
            ))}
          </FunctionCard>
        ))}
      </div>
    </section>
  );
}

export function CompanySection({ role }: { role: string | null | undefined }) {
  if (role === undefined) return <CompanyPending />;
  if (!role || !COMPANY_ROLES.has(role)) return null;
  return <CompanyCards />;
}

function CompanyCards() {
  // One instant per mount, so the leads query key is stable across renders.
  const [since] = React.useState(() => istMonthStartUtc().toISOString());

  const leads = useLeadsCreatedSince(since);
  const trials = useTrials();
  const running = useActiveTrials();
  const deals = useDealRows();
  const invoices = useInvoices();
  const payments = usePayments();
  const projectPayments = useAllProjectPayments();
  const customers = useCustomers();
  const subs = useSubscriptions();
  const tickets = useTicketCounts();
  const queue = useActivationQueue();

  const growth = leads.data ? growthSummary(leads.data) : null;
  const trialsStarted = trials.data ? trialsStartedInMonth(trials.data) : null;
  const dealStrip = deals.data ? summarizeDealStrip(deals.data) : null;
  const money = invoices.data ? invoiceMoney(invoices.data) : null;
  const collected = payments.data && projectPayments.data ? collectedInMonth(payments.data, projectPayments.data) : null;
  const newCustomers = customers.data ? newCustomersInMonth(customers.data) : null;
  const subSummary = subs.data ? subscriptionSummary(subs.data) : null;
  const openTickets = tickets.data ? openTicketCount(tickets.data.counts) : null;
  const waiting = queue.data ? queue.data.counts.waiting : null;

  const money$ = (n: number | null | undefined) => (n == null ? null : rupee(n, { compact: true }));
  const monthName = new Date().toLocaleString("en-IN", { month: "long", timeZone: "Asia/Kolkata" });

  return (
    <section aria-labelledby="dash-company" className="mb-4">
      <h2 id="dash-company" className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
        Company · {monthName}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FunctionCard title="Growth">
          {/* R-1475: was "New leads" — it counts leads ADDED this month in any stage (the
              sum of /lead-gen's channel rows), not the "New" stage or the sidebar's "All
              leads"; Pawan read three different counts as one list. The label says which. */}
          <Metric href="/lead-gen" label="Leads added" value={growth?.newLeads ?? null}
            hint="This month, any stage" {...state(leads)} />
          <Metric href="/lead-gen" label="From the website" value={growth?.fromWebsite ?? null}
            hint="Enquiry, buy and trial forms" {...state(leads)} />
          <Metric href="/subscriptions" label="Trials started" value={trialsStarted} withHint
            hint={running.data ? `${running.data.length} running now` : undefined} {...state(trials)} />
        </FunctionCard>

        <FunctionCard title="Sales">
          <Metric href={drillHref("dealsWonMonth")} label="Won this month" value={money$(dealStrip?.wonThisMonth.value)} withHint
            hint={dealStrip ? plural(dealStrip.wonThisMonth.count, "deal", "deals") : undefined} {...state(deals)} />
          <Metric href={drillHref("dealsOpen")} label="Pipeline" value={money$(dealStrip?.pipeline.value)} withHint
            hint={dealStrip ? plural(dealStrip.pipeline.count, "open deal", "open deals") : undefined} {...state(deals)} />
        </FunctionCard>

        <FunctionCard title="Money">
          <Metric href="/invoices" label="Invoiced" value={money$(money?.invoicedThisMonth.value)} withHint
            hint={money ? plural(money.invoicedThisMonth.count, "invoice", "invoices") : undefined} {...state(invoices)} />
          <Metric href="/payments" label="Collected" value={money$(collected)}
            {...state(payments, projectPayments)} />
          {/* R-1473: billed invoices only (the accrual receivable). Subscription dues not yet
              invoiced are the Collections card's "to collect" figure — the hint says so. */}
          <Metric href={drillHref("invoicesUnpaid")} label="Still owed (invoices)" value={money$(money?.outstanding.value)} withHint
            hint={money ? `${plural(money.outstanding.count, "unpaid invoice", "unpaid invoices")} · sub dues not billed are in Collections` : undefined} {...state(invoices)} />
          <Metric href={drillHref("invoicesOverdue")} label="Overdue invoices" value={money?.overdueCount ?? null}
            {...state(invoices)} />
        </FunctionCard>

        <FunctionCard title="Customers & Ops">
          <Metric href="/customers" label="New customers" value={newCustomers} {...state(customers)} />
          <Metric href={drillHref("subsActive")} label="Monthly revenue (MRR)" value={money$(subSummary?.mrr)} withHint
            hint={subSummary ? plural(subSummary.activeCount, "active subscription", "active subscriptions") : undefined} {...state(subs)} />
          <Metric href={drillHref("subsExpiring")} label="Renewals in 30 days" value={subSummary?.renewalsDue.count ?? null} withHint
            hint={subSummary ? `${money$(subSummary.renewalsDue.value)} a month` : undefined} {...state(subs)} />
          <Metric href="/support" label="Open tickets" value={openTickets} {...state(tickets)} />
          <Metric href="/provisioning" label="Waiting to activate" value={waiting} {...state(queue)} />
        </FunctionCard>
      </div>
    </section>
  );
}
