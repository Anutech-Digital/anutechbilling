/**
 * R-1518 — "This week" on /collections, for owner / manager / accountant only: money received
 * from customers on the follow-up list, promises made / kept / broken, follow-ups logged per
 * person, and customers nobody has followed up for 7+ days.
 *
 * The maths is lib/collections/weekly-report.ts (tested on fixtures). Reads: every follow-up and
 * every received payment from the week (or from the oldest promise due this week) — each paged
 * past the 1000-row cap with fetchAllRows. RLS scopes them to the company.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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

async function fetchReportRows(today: string): Promise<{ followups: ReportFollowup[]; payments: ReportPayment[] }> {
  const supabase = createClient();
  const followups = await fetchAllRows<ReportFollowup>((from, to) => supabase
    .from("payment_followups")
    .select("id, customer_id, promised_on, promised_amount, created_by, created_at")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  const since = istDayStartUtc(paymentsFrom(followups, today)).toISOString();
  const payments = await fetchAllRows<ReportPayment>((from, to) => supabase
    .from("payments")
    .select("customer_id, amount, received_at, status")
    .eq("status", "received")
    .gte("received_at", since)
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  return { followups, payments };
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
            <Tile label="Money received" value={rupee(report.received.total)}
              sub={`${report.received.payments} ${report.received.payments === 1 ? "payment" : "payments"} · ${report.received.customers} ${report.received.customers === 1 ? "customer" : "customers"}`} />
            <Tile label="Promises made" value={String(report.promises.made)}
              sub={report.promises.madeAmount > 0 ? `${rupee(report.promises.madeAmount)} promised` : "logged this week"} />
            <Tile label="Promises kept" value={`${report.promises.kept} of ${report.promises.due}`}
              sub={report.promises.today > 0 ? `${report.promises.today} due today` : "due this week"} tone="good" />
            <Tile label="Promises broken" value={String(report.promises.broken)} sub="date passed, not paid" tone={report.promises.broken > 0 ? "bad" : undefined} />
          </dl>

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
                  {report.quiet.length > 8 && <li className="py-1.5 text-xs text-ink-3">and {report.quiet.length - 8} more in the list below</li>}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </Card>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 p-3 min-w-0">
      <dt className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</dt>
      <dd className={`font-serif text-2xl leading-tight tabular-nums ${tone === "bad" ? "text-rose" : tone === "good" ? "text-emerald" : "text-ink"}`}>{value}</dd>
      <dd className="text-xs text-ink-3 break-words">{sub}</dd>
    </div>
  );
}
