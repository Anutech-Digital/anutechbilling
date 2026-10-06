/**
 * /today — every queue that wants you today, as one ranked list (S29).
 *
 * ─── WHAT THIS PAGE IS, AND IS NOT ──────────────────────────────────────────
 * A pointer, not a workspace. Each row links to the screen that already does that work
 * (the invoice, the quote, the activation queue, the support desk…) and nothing here
 * changes a row. The work used to be spread over ten screens and the money signals —
 * overdue invoices, a halted autopay, a GST return going late — over none of them.
 *
 * Two sources, merged and ranked the same way:
 *   • `today_inbox()` (migration 20260928160000) — every DB-backed queue, read under the
 *     caller's own RLS. The ranking scale is documented at the top of that migration.
 *   • GST / TDS deadlines from lib/compliance/obligations.ts + the filed-log, via
 *     lib/today/inbox.ts — the catalog lives in code, so it is not copied into SQL.
 *
 * If either source fails, the page SAYS so and shows what it does have (AGENTS.md §2, §7):
 * an inbox that silently drops the GST row reads as "nothing due", which is the exact
 * failure this page exists to end.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { useComplianceLog, toFiledMap, useTdsMonths } from "@/lib/queries/compliance";
import { noTdsDeductedPredicate } from "@/lib/compliance/tds-not-applicable";
import { useTodayDealItems } from "@/lib/queries/deals";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canSeeDeals } from "@/lib/deals/access";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate } from "@/lib/utils";
import {
  complianceTodayItems, rankTodayItems, kindMeta, todayWhenLabel, URGENT_PRIORITY, type TodayItem,
} from "@/lib/today/inbox";

function useTodayInbox() {
  return useQuery({
    queryKey: ["today-inbox"],
    queryFn: async (): Promise<TodayItem[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("today_inbox");
      if (error) throw new Error(error.message);
      return (data ?? []) as TodayItem[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** "2d late", "due today", "in 3d" (IST calendar days — R-241), or the arrival time for
 *  queues with no deadline. */
function whenLabel(item: TodayItem, now: number): string {
  const label = todayWhenLabel(item, now);
  if (label !== null) return label;
  // Arrival-style kinds carry when it came in, not a deadline.
  if (!item.due_at || Number.isNaN(Date.parse(item.due_at))) return "";
  return formatDate(item.due_at, "relative");
}

function Row({ item, now }: { item: TodayItem; now: number }) {
  const meta = kindMeta(item.kind);
  const urgent = item.priority >= URGENT_PRIORITY;
  const when = whenLabel(item, now);
  return (
    <li>
      <Link
        href={item.href as Route}
        className={cn(
          "flex items-center gap-3 px-4 py-3 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-lg",
        )}
      >
        <span className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          urgent ? "bg-rose-soft text-rose-ink" : "bg-paper-2 text-ink-3",
        )}>
          <Icon name={meta.icon} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink truncate" title={item.title}>{item.title}</span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
            <Badge kind={urgent ? "danger" : "muted"} size="sm">{meta.label}</Badge>
            {when && <span className={cn(when.endsWith("late") && "text-rose-ink font-medium")}>{when}</span>}
          </span>
        </span>
        <span className="flex-shrink-0 text-xs font-medium text-amber-ink flex items-center gap-1">
          Open <Icon name="arrow_right" size={13} />
        </span>
      </Link>
    </li>
  );
}

export default function TodayPage() {
  const inbox = useTodayInbox();
  const compliance = useComplianceLog();
  /* Deal rows (lib/today/deals.ts) — built in code from open deals, same scale as the SQL. */
  const { data: me } = useCurrentUser();
  const deals = useTodayDealItems(canSeeDeals(me?.role));
  const [kindFilter, setKindFilter] = React.useState<string | null>(null);
  const now = Date.now();

  /* R-181: no TDS deducted in a finished month → no "Deposit TDS" item for it. */
  const tdsToday = React.useMemo(() => new Date(), []);
  const tdsMonths = useTdsMonths(tdsToday);
  const complianceItems = React.useMemo(
    () => (compliance.data
      ? complianceTodayItems(
          new Date(), toFiledMap(compliance.data),
          tdsMonths.data ? noTdsDeductedPredicate(tdsMonths.data, tdsToday) : undefined,
        )
      : []),
    [compliance.data, tdsMonths.data, tdsToday],
  );
  const all = React.useMemo(
    () => rankTodayItems([...(inbox.data ?? []), ...complianceItems, ...deals.items]),
    [inbox.data, complianceItems, deals.items],
  );
  const counts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const shown = kindFilter ? all.filter((i) => i.kind === kindFilter) : all;
  const first = shown.filter((i) => i.priority >= URGENT_PRIORITY);
  const rest = shown.filter((i) => i.priority < URGENT_PRIORITY);
  const loading = inbox.isLoading || compliance.isLoading || deals.isLoading;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Today</h1>
          <p className="text-sm text-ink-3 mt-1">
            Har queue ka kaam ek list mein — sabse zaroori sabse upar. Click karo, seedha us screen par.
          </p>
        </div>
        <Button icon="refresh" variant="ghost" onClick={() => { inbox.refetch(); compliance.refetch(); deals.refetch(); }}>
          Refresh
        </Button>
      </div>

      {inbox.error && (
        <Card className="p-4 mb-4 border-rose-soft">
          <p className="text-sm text-rose-ink font-medium">Queues could not be loaded — {inbox.error.message}</p>
          <p className="text-xs text-ink-3 mt-1">
            Nothing below is the full picture until this loads. If the message says the function does not exist,
            migration 20260928160000_today_inbox has not been applied to this database yet.
          </p>
          <Button className="mt-2" size="sm" icon="refresh" onClick={() => inbox.refetch()}>Try again</Button>
        </Card>
      )}
      {compliance.error && (
        <Card className="p-4 mb-4 border-amber-soft">
          <p className="text-sm text-amber-ink font-medium">GST / TDS deadlines could not be loaded — {(compliance.error as Error).message}</p>
          <p className="text-xs text-ink-3 mt-1">
            Their absence below does not mean nothing is due. <Link href={"/compliance" as Route} className="underline">Open the Compliance Calendar</Link>.
          </p>
        </Card>
      )}

      {deals.error && (
        <Card className="p-4 mb-4 border-amber-soft">
          <p className="text-sm text-amber-ink font-medium">Deals could not be loaded — {(deals.error as Error).message}</p>
          <p className="text-xs text-ink-3 mt-1">
            Late or closing deals are missing below until this loads. <Link href={"/deals" as Route} className="underline">Open Deals</Link>.
          </p>
        </Card>
      )}

      {loading && (
        <Card className="p-4 space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</Card>
      )}

      {!loading && !inbox.error && all.length === 0 && (
        <EmptyState
          icon="check_circle"
          title="All clear for today"
          body="No overdue invoices, no waiting approvals, nothing queued. New work shows up here within a minute."
        />
      )}

      {!loading && all.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4" role="group" aria-label="Filter by queue">
            <button
              type="button"
              aria-pressed={kindFilter === null}
              onClick={() => setKindFilter(null)}
              className={cn("rounded-full border px-2.5 py-1 text-xs", kindFilter === null ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}
            >
              All · {all.length}
            </button>
            {counts.map(([k, n]) => (
              <button
                key={k}
                type="button"
                aria-pressed={kindFilter === k}
                onClick={() => setKindFilter(kindFilter === k ? null : k)}
                className={cn("rounded-full border px-2.5 py-1 text-xs", kindFilter === k ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}
              >
                {kindMeta(k).label} · {n}
              </button>
            ))}
          </div>

          {first.length > 0 && (
            <section className="mb-5" aria-labelledby="today-first">
              <h2 id="today-first" className="text-xs uppercase tracking-wider text-rose-ink font-semibold mb-2">
                Do first · {first.length}
              </h2>
              <Card className="p-1"><ul className="divide-y divide-hairline">
                {first.map((i) => <Row key={`${i.kind}:${i.id}`} item={i} now={now} />)}
              </ul></Card>
            </section>
          )}
          {rest.length > 0 && (
            <section aria-labelledby="today-rest">
              <h2 id="today-rest" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                Also today · {rest.length}
              </h2>
              <Card className="p-1"><ul className="divide-y divide-hairline">
                {rest.map((i) => <Row key={`${i.kind}:${i.id}`} item={i} now={now} />)}
              </ul></Card>
            </section>
          )}
          <p className="text-xs text-ink-3 mt-4">
            Each queue shows up to 50 items here; its own screen has the rest.
          </p>
        </>
      )}
    </div>
  );
}
