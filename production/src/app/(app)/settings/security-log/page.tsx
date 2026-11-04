/**
 * Settings → Security log — R-2350 (2 Nov 2026, goal G-DPDP).
 *
 * Who opened which customer or lead, and who exported what (R-1006), newest first. Owner only
 * (menu, middleware and the database all agree — the view `security_log` shows rows to the
 * owner of the company and to no one else). Filter by person, record type and date; Export CSV
 * downloads what is on screen (and is itself logged as an export).
 * Nothing here changes who can see a customer or a lead.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { downloadCSV } from "@/lib/csv";
import { istToday } from "@/lib/dates/ist";
import { useSecurityLog } from "@/lib/security-log/queries";
import {
  csvRows, CSV_HEADERS, EMPTY_FILTER, SECURITY_LOG_LIMIT, type SecurityLogFilter,
} from "@/lib/security-log/log";
import { LogTable } from "./log-table";

const selectCls = "w-full h-10 rounded-lg border border-hairline-strong bg-paper px-3 text-sm";

export default function SecurityLogPage() {
  const { data: me } = useCurrentUser();
  const allowed = me == null || me.role === "owner";
  const [filter, setFilter] = React.useState<SecurityLogFilter>(EMPTY_FILTER);
  const q = useSecurityLog(filter, allowed);
  const { data: names } = useUserNames();
  const rows = q.data ?? [];

  const personOf = React.useCallback(
    (id: string | null) => (id ? names?.get(id)?.label ?? "a colleague" : "a removed user"),
    [names],
  );
  const people = React.useMemo(
    () => [...(names?.values() ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
    [names],
  );
  const set = <K extends keyof SecurityLogFilter>(k: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilter((f) => ({ ...f, [k]: e.target.value }));
  const filtered = filter.userId !== "" || filter.recordType !== "" || filter.from !== "" || filter.to !== "";

  function onExport() {
    downloadCSV(`security-log-${istToday()}.csv`, CSV_HEADERS, csvRows(rows, personOf));
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto">
      <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
      <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Security log</h1>
      <p className="text-sm text-ink-2 mt-1 mb-4 max-w-3xl">
        Who opened which customer or lead, and who exported data — newest first. Opening the same record again
        within 10 minutes counts once. Only you, the owner, can see this page.
      </p>

      {!allowed ? (
        <Card className="py-2">
          <EmptyState icon="lock" title="Only the owner can see the security log"
            body="It shows who looked at which customer or lead. Ask your owner to open this page." />
        </Card>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_160px_160px_auto] lg:items-end">
            <label className="text-xs text-ink-3">Person
              <select aria-label="Person" className={selectCls} value={filter.userId} onChange={set("userId")}>
                <option value="">Everyone</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.label}{p.inactive ? " (inactive)" : ""}</option>)}
              </select>
            </label>
            <label className="text-xs text-ink-3">Record type
              <select aria-label="Record type" className={selectCls} value={filter.recordType} onChange={set("recordType")}>
                <option value="">All</option>
                <option value="customer">Customers</option>
                <option value="lead">Leads</option>
                <option value="export">Exports</option>
              </select>
            </label>
            <label className="text-xs text-ink-3">From
              <Input aria-label="From" type="date" value={filter.from} onChange={set("from")} />
            </label>
            <label className="text-xs text-ink-3">To
              <Input aria-label="To" type="date" value={filter.to} onChange={set("to")} />
            </label>
            <div className="flex gap-2">
              {filtered && <Button size="sm" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>Clear</Button>}
              <Button size="sm" icon="download" disabled={rows.length === 0} onClick={onExport}>Export CSV</Button>
            </div>
          </div>

          {q.isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : q.isError ? (
            <LoadError what="Security log" error={q.error} onRetry={() => { void q.refetch(); }} />
          ) : rows.length === 0 ? (
            <Card className="py-2">
              <EmptyState icon="shield" title={filtered ? "Nothing matches these filters" : "Nothing logged yet"}
                body={filtered ? "Try another person, type or date." : "When someone opens a customer or a lead, or exports data, it shows here."} />
            </Card>
          ) : (
            <>
              <LogTable rows={rows} personOf={personOf} />
              {rows.length >= SECURITY_LOG_LIMIT && (
                <p className="mt-2 text-xs text-ink-3">Showing the latest {SECURITY_LOG_LIMIT}. Narrow the dates to see older entries.</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
