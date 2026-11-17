"use client";
/* R-2892 — "Pay selected" on Run payroll. Shows every ticked employee's net and the total, leaves out
   (with the reason) anyone already run / without a salary / with no net, then books the rest ONE BY
   ONE through the same usePaySalary mutation the single Pay salary button uses. The first failure
   stops the run and the screen says who was paid and who was not. Figures come from
   lib/payroll/salary-draft.ts — the ones Pay salary opens with, LOP from attendance applied. */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rupee, toTitleCase } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { periodLabel } from "@/lib/payroll/period-label";
import { buildSalaryDraft, lopSuggestionForMonth } from "@/lib/payroll/salary-draft";
import { bulkPayInput, bulkSkipReason, bulkTotal, runBulkPay, type BulkPlanRow, type BulkRunResult } from "@/lib/payroll/bulk-pay";
import type { SalaryRevision } from "@/lib/payroll/salary-revision";
import { DEFAULT_SHIFT } from "@/lib/attendance/shift";
import { useBankAccounts } from "@/lib/queries/bank";
import { useShiftRules } from "@/lib/queries/attendance-shift";
import {
  fetchEmployeeSalaryHistory, fetchRunEmployeeIds, fetchSalaryArrears, useAttendance, useHolidays, useLeaveEntries, usePaySalary,
  type Employee,
} from "@/lib/queries/payroll";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

export function BulkPayDialog({ employees, period, revisions, runIds, onClose }: {
  employees: readonly Employee[];
  period: string;
  revisions: readonly SalaryRevision[];
  /** Employees that already have a salary row this month (the screen's own list). */
  runIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const accounts = (useBankAccounts().data ?? []).filter((a) => a.is_active);
  const attQ = useAttendance(period);
  const leaveQ = useLeaveEntries();
  const holQ = useHolidays();
  const shiftQ = useShiftRules();
  const pay = usePaySalary({ quiet: true });
  const [accountId, setAccountId] = React.useState("");
  const [date, setDate] = React.useState(istToday());
  const [running, setRunning] = React.useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = React.useState<BulkRunResult | null>(null);

  /* Same default bank as Pay salary: the first bank-like account, not Petty Cash. */
  React.useEffect(() => {
    if (accounts.length > 0 && (!accountId || !accounts.some((a) => a.id === accountId))) {
      const bank = accounts.find((a) => a.account_type !== "cash" && a.account_type !== "credit_card");
      setAccountId((bank ?? accounts[0]).id);
    }
  }, [accounts, accountId]);

  /* Each person's payslips (ESI period, TDS so far) and revision arrears — what the Pay salary form reads. */
  const ids = employees.map((e) => e.id);
  const factsQ = useQuery({
    queryKey: ["bulk-pay-facts", period, ids.join(",")],
    queryFn: async () => {
      const entries = await Promise.all(ids.map(async (id) => [id, { history: await fetchEmployeeSalaryHistory(id), arrears: await fetchSalaryArrears(id) }] as const));
      return new Map(entries);
    },
    staleTime: 0,
    gcTime: 0,
  });
  const ready = factsQ.isSuccess && attQ.isSuccess && leaveQ.isSuccess && holQ.isSuccess;

  const rows: BulkPlanRow[] = React.useMemo(() => {
    if (!ready || !factsQ.data) return [];
    const today = istToday();
    return employees.map((e) => {
      const facts = factsQ.data.get(e.id);
      const revs = revisions.filter((r) => r.employee_id === e.id);
      const lop = lopSuggestionForMonth({
        period, employee: e, todayIso: today,
        companyHolidays: (holQ.data ?? []).map((h) => h.holiday_date),
        attendance: attQ.data ?? [], leaves: leaveQ.data ?? [], rules: shiftQ.data ?? DEFAULT_SHIFT,
      });
      const draft = facts ? buildSalaryDraft({ employee: e, period, todayIso: today, revisions: revs, history: facts.history, arrears: facts.arrears, lop }) : null;
      const skip = bulkSkipReason({ employee: e, alreadyRun: runIds.has(e.id), draft, bankAccountId: accountId || null });
      return {
        employeeId: e.id, name: toTitleCase(e.name), draft, skip,
        input: !skip && draft ? bulkPayInput(draft, e.id, date, accountId) : null,
      };
    });
  }, [ready, factsQ.data, employees, revisions, period, runIds, accountId, date, holQ.data, attQ.data, leaveQ.data, shiftQ.data]);

  const total = bulkTotal(rows);
  const nameOf = (id: string) => rows.find((r) => r.employeeId === id)?.name ?? "Employee";

  async function start() {
    if (running || total.count === 0) return;
    setResult(null);
    setRunning({ done: 0, total: total.count });
    const r = await runBulkPay({
      rows,
      readRunIds: () => fetchRunEmployeeIds(period),
      pay: (input) => pay.mutateAsync(input),
      onProgress: (done, t) => setRunning({ done, total: t }),
    });
    setRunning(null);
    setResult(r);
    qc.invalidateQueries({ queryKey: ["salary-payments"] });
  }

  const finished = result !== null;
  const stopped = Boolean(result?.failed);

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !running) onClose(); }}>
      <DialogContent className="md:!max-w-3xl">
        <DialogHeader>
          <DialogTitle>Pay selected — {periodLabel(period)}</DialogTitle>
          <DialogDescription>
            Each salary is booked exactly as Pay salary would book it, one after another. Bonus and advance recovery stay in Pay salary.
          </DialogDescription>
        </DialogHeader>

        {!finished && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="bulk-pay-from" className="block text-xs font-medium text-ink-2 mb-1">Pay from</label>
              <select id="bulk-pay-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls} disabled={Boolean(running)}>
                {accounts.length === 0 && <option value="">Add an account in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bulk-pay-date" className="block text-xs font-medium text-ink-2 mb-1">Pay date</label>
              <Input id="bulk-pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={Boolean(running)} />
            </div>
          </div>
        )}

        {factsQ.isError ? (
          <p role="alert" className="text-sm text-rose">Could not read the salary details — close and try again.</p>
        ) : !ready ? (
          <div className="space-y-2" aria-label="Working out each salary">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-md border border-hairline">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-3 py-2">Employee</th>
                  <th className="text-right px-3 py-2">Gross</th>
                  <th className="text-right px-3 py-2">LOP</th>
                  <th className="text-right px-3 py-2">PF / ESI / TDS</th>
                  <th className="text-right px-3 py-2">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => {
                  const d = r.draft;
                  const outcome = result
                    ? result.paid.includes(r.employeeId) ? "Paid"
                      : result.alreadyRun.includes(r.employeeId) ? "Already run"
                        : result.failed?.employeeId === r.employeeId ? "Failed"
                          : result.notRun.includes(r.employeeId) ? "Not run" : null
                    : null;
                  return (
                    <tr key={r.employeeId} data-testid={`bulk-row-${r.employeeId}`} className={r.skip ? "text-ink-3" : undefined}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{r.name}</div>
                        {r.skip && <div className="text-xs text-amber-ink">Skipped — {r.skip}</div>}
                        {outcome && <div className="text-xs text-ink-2" data-testid={`bulk-outcome-${r.employeeId}`}>{outcome}</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{d ? rupee(d.gross) : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{d && d.lopDays > 0 ? `${d.lopDays}d · −${rupee(d.lopAmount)}` : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{d ? `−${rupee(d.pf + d.esi + d.tds)}` : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono font-medium">{d && !r.skip ? rupee(d.net) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ready && !finished && (
          <p className="text-sm text-ink-2" data-testid="bulk-total">
            {total.count} {total.count === 1 ? "salary" : "salaries"} to book · total net <b>{rupee(total.net)}</b>
            {rows.length - total.count > 0 && ` · ${rows.length - total.count} skipped`}
          </p>
        )}

        {result && (
          <div role="status" data-testid="bulk-result" className="rounded-md bg-paper-2/50 p-3 text-sm space-y-1">
            <div><b>{result.paid.length}</b> booked{result.alreadyRun.length > 0 ? `, ${result.alreadyRun.length} already run` : ""}.</div>
            {result.failed && (
              <div className="text-rose">
                Stopped at {nameOf(result.failed.employeeId)}: {result.failed.message}. {result.notRun.length > 0 ? `Not run: ${result.notRun.map(nameOf).join(", ")}.` : ""} Nobody after the failure was touched.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {running && <p className="mr-auto self-center text-xs text-ink-3" aria-live="polite">Booking {running.done} of {running.total}…</p>}
          <Button variant="ghost" onClick={onClose} disabled={Boolean(running)}>{finished && !stopped ? "Done" : "Close"}</Button>
          {(!finished || stopped) && (
            <Button variant="primary" onClick={start} loading={Boolean(running)} disabled={!ready || total.count === 0 || Boolean(running)}>
              {stopped ? "Retry the rest" : ready ? `Pay ${total.count} · ${rupee(total.net)}` : "Pay…"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
