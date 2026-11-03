/**
 * R-1518 — "This week" on /collections, for owner / manager / accountant only: money received
 * from customers on the follow-up list, promises made / kept / broken, follow-ups logged per
 * person, and customers nobody has followed up for 7+ days.
 *
 * The maths is lib/collections/weekly-report.ts (tested on fixtures). Reads: every follow-up and
 * every received payment from the week (or from the oldest promise due this week) — each paged
 * past the 1000-row cap with fetchAllRows. RLS scopes them to the company.
 *
 * R-2414 — "Collection health, last 30 days": DSO, best possible DSO, average days late, CEI and
 * promise-kept %, each with a one-line formula on hover / focus. Maths: lib/collections/
 * collection-metrics.ts. The amount owed is the /collections list itself (useCollections — the
 * same invoiceAmountDue as Customer Aging, already loaded; no second definition). The only extra
 * read is the invoices issued in the 30 days (sales); payments are read from the earlier start
 * of the two windows.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadError } from "@/components/shared/load-error";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { istDayStartUtc, istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";
import {
  buildWeeklyReport, paymentsFrom, QUIET_DAYS,
  type ReportFollowup, type ReportOwing, type ReportPayment, type WeeklyReport,
} from "@/lib/collections/weekly-report";
import {
  buildCollectionMetrics, ISSUED_STATUSES, METRIC_FORMULA, metricsPaymentsFrom, metricsStart,
  type CollectionMetrics, type Metric, type MetricsInvoice,
} from "@/lib/collections/collection-metrics";
import { useCollections } from "@/lib/queries/collections";

type ReportRows = { followups: ReportFollowup[]; payments: ReportPayment[]; invoices: MetricsInvoice[] };

async function fetchReportRows(today: string): Promise<ReportRows> {
  const supabase = createClient();
  const followups = await fetchAllRows<ReportFollowup>((from, to) => supabase
    .from("payment_followups")
    .select("id, customer_id, promised_on, promised_amount, created_by, created_at")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  const weekFrom = paymentsFrom(followups, today);
  const metricsFrom = metricsPaymentsFrom(followups, today);
  const since = istDayStartUtc(metricsFrom < weekFrom ? metricsFrom : weekFrom).toISOString();
  const payments = await fetchAllRows<ReportPayment>((from, to) => supabase
    .from("payments")
    .select("customer_id, amount, credit_applied, received_at, status")
    .eq("status", "received")
    .gte("received_at", since)
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  // R-2414: credit sales of the last 30 days (issued invoices only).
  const invoices = await fetchAllRows<MetricsInvoice>((from, to) => supabase
    .from("invoices")
    .select("id, invoice_date, status, net_payable, amount")
    .in("status", [...ISSUED_STATUSES])
    .gte("invoice_date", metricsStart(today))
    .lte("invoice_date", today)
    .order("invoice_date", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  return { followups, payments, invoices };
}

export function CollectionsOwnerReport({ owing }: { owing: readonly ReportOwing[] }) {
  const today = istToday();
  const q = useQuery({
    queryKey: ["collections", "owner-report", today],
    queryFn: () => fetchReportRows(today),
    staleTime: 60_000,
  });
  const { data: names } = useUserNames();
  const report: WeeklyReport | null = React.useMemo(
    () => (q.data ? buildWeeklyReport({ today, owing, followups: q.data.followups, payments: q.data.payments }) : null),
    [q.data, today, owing],
  );
  // R-2414: the same rows /collections shows (react-query cache — not read twice).
  const { data: rows } = useCollections();
  const metrics: CollectionMetrics | null = React.useMemo(() => {
    if (!q.data || !rows) return null;
    return buildCollectionMetrics({
      today,
      lines: rows.flatMap((r) => r.items),
      invoices: q.data.invoices,
      payments: q.data.payments,
      followups: q.data.followups,
      owesNow: new Set(rows.flatMap((r) => (r.customerId && r.amountDue > 0 ? [r.customerId] : []))),
    });
  }, [q.data, rows, today]);
  const owingName = React.useMemo(() => new Map(owing.map((o) => [o.customerId, o.customerName])), [owing]);

  return (
    <Card className="p-4 md:p-5 mb-5" aria-labelledby="owner-report-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 id="owner-report-h" className="font-serif text-xl text-ink">This week</h2>
        {report && <p className="text-xs text-ink-3">{formatDate(report.weekStart)} – today · owner, manager and accountant only</p>}
      </div>

      {q.isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : q.isError || !report ? (
        <LoadError what="This week's follow-up report" onRetry={() => { void q.refetch(); }} />
      ) : (
        <>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Received from follow-up list" value={rupee(report.received.total)}
              sub={`${report.received.payments} ${report.received.payments === 1 ? "payment" : "payments"} · ${report.received.customers} ${report.received.customers === 1 ? "customer" : "customers"}`} />
            <Tile label="Promises made" value={String(report.promises.made)}
              sub={report.promises.madeAmount > 0 ? `${rupee(report.promises.madeAmount)} promised` : "logged this week"} />
            <Tile label="Promises kept" value={`${report.promises.kept} of ${report.promises.due}`}
              sub={report.promises.today > 0 ? `${report.promises.today} due today` : "due this week"} tone="good" />
            <Tile label="Promises broken" value={String(report.promises.broken)} sub="date passed, not paid" tone={report.promises.broken > 0 ? "bad" : undefined} />
          </dl>

          {metrics && <HealthTiles m={metrics} />}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <section aria-labelledby="per-person-h">
              <h3 id="per-person-h" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Follow-ups logged, by person</h3>
              {report.perPerson.length === 0 ? (
                <p className="text-sm text-ink-3">No follow-ups logged this week yet.</p>
              ) : (
                <ul className="divide-y divide-hairline text-sm">
                  {report.perPerson.map((p) => (
                    <li key={p.userId ?? "none"} className="flex justify-between gap-2 py-1.5">
                      <span className="min-w-0 break-words text-ink">{p.userId ? names?.get(p.userId)?.label ?? "A colleague" : "Unknown"}</span>
                      <span className="tabular-nums text-ink-2">{p.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="quiet-h">
              <h3 id="quiet-h" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                No follow-up for {QUIET_DAYS}+ days ({report.quiet.length})
              </h3>
              {report.quiet.length === 0 ? (
                <p className="text-sm text-ink-3">Everyone who owes money was followed up in the last {QUIET_DAYS} days.</p>
              ) : (
                <ul className="divide-y divide-hairline text-sm">
                  {report.quiet.slice(0, 8).map((c) => (
                    <li key={c.customerId} className="flex justify-between gap-2 py-1.5">
                      <span className="min-w-0 break-words">
                        <Link href={`/customers/${encodeURIComponent(c.customerId)}` as Route} className="text-ink hover:underline underline-offset-2">
                          {owingName.get(c.customerId) ?? c.customerName}
                        </Link>
                        <span className="block text-xs text-ink-3">{c.days === null ? "Never followed up" : `Last follow-up ${c.days} days ago`}</span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-ink-2">{rupee(c.amountDue)}</span>
                    </li>
                  ))}
                  {report.quiet.length > 8 && <li className="py-1.5 text-xs text-ink-3">and {report.quiet.length - 8} more in the list above</li>}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </Card>
  );
}

/** R-2414: the five health numbers, each with its formula on hover / keyboard focus. */
function HealthTiles({ m }: { m: CollectionMetrics }) {
  const days = (x: Metric) => (x.value === null ? "—" : `${x.value} ${x.value === 1 ? "day" : "days"}`);
  const pct = (x: Metric) => (x.value === null ? "—" : `${x.value}%`);
  const sub = (x: Metric, text: string) => (x.value === null ? x.reason : text);
  return (
    <section aria-labelledby="health-h" className="mt-4">
      <h3 id="health-h" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        Collection health · last {m.days} days ({formatDate(m.periodStart)} – today)
      </h3>
      <dl className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="DSO" value={days(m.dso)} formula={METRIC_FORMULA.dso}
          sub={sub(m.dso, `${rupee(m.closingAr)} owed · ${rupee(m.sales)} invoiced`)} />
        <Tile label="Best possible DSO" value={days(m.bestDso)} formula={METRIC_FORMULA.bestDso}
          sub={sub(m.bestDso, `${rupee(m.currentAr)} not due yet`)} />
        <Tile label="Average days late" value={days(m.avgDaysLate)} formula={METRIC_FORMULA.avgDaysLate}
          sub={sub(m.avgDaysLate, `${rupee(m.overdueAr)} overdue · aim under 15`)}
          tone={m.avgDaysLate.value !== null && m.avgDaysLate.value > 15 ? "bad" : undefined} />
        <Tile label="CEI" value={pct(m.cei)} formula={METRIC_FORMULA.cei}
          sub={sub(m.cei, `${rupee(m.received)} received · closer to 100% is better`)} />
        <Tile label="Promises kept" value={pct(m.promiseKept)} formula={METRIC_FORMULA.promiseKept}
          sub={m.promiseKept.value === null ? m.promiseKept.reason : `${m.promiseKept.kept} of ${m.promiseKept.due} that fell due`} />
      </dl>
    </section>
  );
}

function Tile({ label, value, sub, tone, formula }: { label: string; value: string; sub: string; tone?: "good" | "bad"; formula?: string }) {
  const body = (
    <div
      className="rounded-md border border-hairline bg-paper-2/40 p-3 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      tabIndex={formula ? 0 : undefined}
    >
      <dt className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</dt>
      <dd className={`font-serif text-2xl leading-tight tabular-nums ${tone === "bad" ? "text-rose" : tone === "good" ? "text-emerald" : "text-ink"}`}>{value}</dd>
      <dd className="text-xs text-ink-3 break-words">{sub}</dd>
    </div>
  );
  if (!formula) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal">{formula}</TooltipContent>
    </Tooltip>
  );
}
