/**
 * R-1896 — "Start exit": the first step when an employee leaves.
 *
 * Asks only what the exit needs — resignation date, notice, last working day, reason — with
 * smart defaults (today; 30 days; resignation + notice − 1). One RPC (start_employee_exit) puts
 * the last working day on the employee and ends their linked login after that day. Payroll then
 * keeps them for that month only (pro-rata to the last day) and never after it.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { EXIT_REASONS, defaultLastDay, noticeShortfall, type ExitReason } from "@/lib/payroll/exit";
import { useStartEmployeeExit } from "@/lib/queries/payroll";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

export function StartExitDialog({
  employee, onClose,
}: {
  employee: { id: string; name: string; joining_date?: string | null };
  onClose: () => void;
}) {
  const start = useStartEmployeeExit();
  const today = istToday();
  const [resigned, setResigned] = React.useState(today);
  const [notice, setNotice] = React.useState("30");
  const [lastDay, setLastDay] = React.useState(defaultLastDay(today, 30));
  const [lastDayTouched, setLastDayTouched] = React.useState(false);
  const [reason, setReason] = React.useState<ExitReason>("resigned");
  const [note, setNote] = React.useState("");

  const noticeDays = Math.max(0, Math.round(Number(notice) || 0));
  /* Until the owner picks a last day, it follows resignation date + notice. */
  React.useEffect(() => {
    if (!lastDayTouched && resigned) setLastDay(defaultLastDay(resigned, noticeDays));
  }, [resigned, noticeDays, lastDayTouched]);

  const beforeJoining = !!lastDay && !!employee.joining_date && lastDay < employee.joining_date;
  const afterResigned = !!lastDay && !!resigned && lastDay >= resigned;
  const notice_ = resigned && lastDay && afterResigned
    ? noticeShortfall({ resignationDate: resigned, lastDay, noticeDays })
    : null;
  const valid = !!lastDay && !beforeJoining && (!resigned || afterResigned);

  const submit = () => {
    if (!valid) return;
    start.mutate(
      { employeeId: employee.id, lastDay, reason, resignationDate: resigned || null, note: note.trim() || null },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start exit — {employee.name}</DialogTitle>
          <DialogDescription>
            Payroll pays them up to the last working day and stops after that month. Their history stays.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Resignation date" htmlFor="exit-resigned">
              <Input id="exit-resigned" type="date" value={resigned} onChange={(e) => setResigned(e.target.value)} />
            </FormField>
            <FormField label="Notice period (days)" htmlFor="exit-notice">
              <Input id="exit-notice" type="number" min={0} inputMode="numeric" value={notice} onChange={(e) => setNotice(e.target.value)} />
            </FormField>
            <FormField label="Last working day" required htmlFor="exit-last-day">
              <Input id="exit-last-day" type="date" value={lastDay}
                onChange={(e) => { setLastDay(e.target.value); setLastDayTouched(true); }} />
            </FormField>
            <FormField label="Reason" required htmlFor="exit-reason">
              <select id="exit-reason" value={reason} onChange={(e) => setReason(e.target.value as ExitReason)} className={selectCls}>
                {EXIT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </FormField>
          </div>

          {beforeJoining && (
            <p className="text-xs text-rose">The last working day is before they joined ({formatDate(employee.joining_date!)}).</p>
          )}
          {!beforeJoining && resigned && lastDay && !afterResigned && (
            <p className="text-xs text-rose">The last working day cannot be before the resignation date.</p>
          )}
          {notice_ && noticeDays > 0 && (
            notice_.short > 0
              ? <p className="text-xs text-amber-ink">Notice served {notice_.served} days — <b>{notice_.short} days short of the {noticeDays}-day notice</b>. Recovery or waiver is settled in Full &amp; Final.</p>
              : <p className="text-xs text-ink-3">Full notice served ({notice_.served} days).</p>
          )}

          <FormField label="Note (optional)" htmlFor="exit-note">
            <Textarea id="exit-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. moving city, handover to Asha" />
          </FormField>

          {lastDay && valid && (
            <p className="text-xs text-ink-2 rounded-md bg-paper-2/60 px-3 py-2">
              If they have a login, it stops working after <b>{formatDate(lastDay)}</b> — app, sessions and password vault.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={start.isPending}>Cancel</Button>
          <Button variant="primary" loading={start.isPending} disabled={!valid} onClick={submit}>Start exit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
