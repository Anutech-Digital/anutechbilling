/**
 * Month-end close — one screen, one month: what the books already prove, what the
 * owner did on a portal, and the lock at the end. lib/accounting/month-close.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { useMonthClose, useSetManualCheck } from "@/lib/queries/month-close";
import { useUpdateTenant } from "@/lib/queries/tenant";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, cn } from "@/lib/utils";
import type { CloseStep } from "@/lib/accounting/month-close";
import { addDaysISO, istMonth, monthBounds } from "@/lib/dates/ist";

/** Last IST calendar month (YYYY-MM) — the GST period being closed. lib/dates/ist.ts. */
function prevPeriod(): string {
  return addDaysISO(monthBounds(istMonth()).start, -1).slice(0, 7);
}
function periodLabel(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

const TONE: Record<CloseStep["status"], { icon: "check" | "alert" | "x" | "clock"; cls: string; label: string }> = {
  done: { icon: "check", cls: "text-emerald", label: "Done" },
  todo: { icon: "x", cls: "text-rose", label: COPY.pending },
  warn: { icon: "alert", cls: "text-amber-ink", label: COPY.check },
  na: { icon: "clock", cls: "text-ink-3", label: "N/A" },
};

export default function MonthClosePage() {
  const [period, setPeriod] = React.useState(prevPeriod());
  const { data, isLoading, isError, refetch } = useMonthClose(period);
  const tick = useSetManualCheck();
  const update = useUpdateTenant();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const close = data?.close;

  async function lock() {
    if (!data) return;
    const ok = await confirm({
      title: `Lock books up to ${formatDate(data.facts.monthEnd)}?`,
      body: "No entry up to that date (expense, bank line, salary, tax, invoice, payment) can be changed or deleted in the app. Do this after your returns are filed.",
      confirmLabel: "Yes, lock", cancelLabel: COPY.cancel,
    });
    if (!ok) return;
    await update.mutateAsync({ books_locked_until: data.facts.monthEnd });
    qc.invalidateQueries({ queryKey: ["month-close", period] });
    qc.invalidateQueries({ queryKey: ["books-lock"] });
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[960px] mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            <Link href={"/accounting" as Route} className="hover:text-ink">Accounting</Link> · Month-end
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Month-end close</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Work down this list every month. Steps the books can prove tick themselves; tick the portal steps yourself, then lock.
          </p>
        </div>
        <div>
          <label htmlFor="close-month" className="block text-xs font-medium text-ink-2 mb-1">Month</label>
          <Input id="close-month" type="month" value={period} max={prevPeriod() > period ? prevPeriod() : period} onChange={(e) => setPeriod(e.target.value)} className="w-44" />
        </div>
      </div>

      {/* Before S32 a failed load stayed a skeleton forever. */}
      {isError ? (
        <LoadError what="Month-end checklist" onRetry={() => refetch()} />
      ) : isLoading || !close || !data ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <>
          <Card className={cn("mb-4 p-4", close.locked ? "border-emerald/40 bg-emerald/5" : close.readyToLock ? "border-amber/40 bg-amber-soft/20" : "")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-serif text-2xl text-ink">{periodLabel(period)} — {close.done} / {close.total}</div>
                <div className="text-xs text-ink-3 mt-0.5">
                  {close.locked ? "Month closed. Books are locked." : close.readyToLock ? "All steps done. Lock the books now." : `${close.total - close.done} step(s) left.`}
                </div>
              </div>
              {!close.locked && (
                isOwner
                  ? <Button variant="primary" disabled={!close.readyToLock || update.isPending} loading={update.isPending} onClick={lock} icon="lock">Lock books up to {formatDate(data.facts.monthEnd)}</Button>
                  : <span className="text-xs text-ink-3">Only the owner can lock</span>
              )}
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-paper-2 overflow-hidden">
              <div className={cn("h-full", close.locked ? "bg-emerald" : "bg-amber")} style={{ width: `${close.total ? Math.round((close.done / close.total) * 100) : 0}%` }} />
            </div>
          </Card>

          <div className="space-y-2">
            {close.steps.map((s, i) => {
              const t = TONE[s.status];
              return (
                <Card key={s.key} className={cn("p-3 md:p-4", s.status === "na" && "opacity-60")}>
                  <div className="flex items-start gap-3">
                    <div className={cn("mt-0.5 shrink-0 w-6 h-6 rounded-full border border-hairline flex items-center justify-center", t.cls)}>
                      <Icon name={t.icon} size={13} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink-3 font-mono">{i + 1}.</span>
                        <span className="font-semibold text-ink">{s.title}</span>
                        <span className={cn("text-xs font-semibold", t.cls)}>{t.label}</span>
                        {s.kind === "manual" && <span className="text-3xs uppercase tracking-wider text-ink-3 border border-hairline rounded px-1">portal</span>}
                      </div>
                      <p className="text-xs text-ink-2 mt-0.5 leading-relaxed">{s.detail}{s.doneAt ? ` (tick: ${formatDate(s.doneAt.slice(0, 10))})` : ""}</p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {s.kind === "manual" && (
                        <Button size="sm" variant={s.status === "done" ? "ghost" : "primary"} disabled={tick.isPending}
                          onClick={() => tick.mutate({ period, key: s.key, done: s.status !== "done" })}>
                          {s.status === "done" ? "Untick" : `${COPY.done} ✓`}
                        </Button>
                      )}
                      {s.href && s.status !== "na" && s.key !== "lock" && (
                        <Link href={s.href as Route} className="text-xs text-amber-ink underline whitespace-nowrap">{COPY.open} →</Link>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
