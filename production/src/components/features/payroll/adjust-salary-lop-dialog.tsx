/**
 * R-2428 — Payroll → ⋯ → "Edit salary — LOP" on a salary that is part-paid from the bank.
 *
 * Owner's case (staging, 3 Nov): Keshav Malik's April record was ₹24,358; his full & final paid
 * ₹19,056 and was linked, so the record read "partially paid, ₹5,302 owed" — false. "Edit salary"
 * (undo + pay again) is refused once a bank line is linked. Here the owner sets loss of pay
 * (days + ₹) so the net = the amount actually paid, with a reason; one RPC (adjust_salary_lop)
 * moves the net, the booked Salaries expense and the paid status together.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { rupee } from "@/lib/utils";
import { periodLabel } from "@/lib/payroll/period-label";
import { lopForNet, lopProblem, netAfterLop } from "@/lib/payroll/salary-lop";
import { useAdjustSalaryLop, type SalaryPayment } from "@/lib/queries/payroll";

export function AdjustSalaryLopDialog({ name, salary, onClose }: {
  name: string;
  salary: SalaryPayment;
  onClose: () => void;
}) {
  const adjust = useAdjustSalaryLop();
  /* Part-paid: start from "net = what the bank paid" — the usual reason to be here. */
  const paidTarget = salary.paid_amount > 0 ? lopForNet(salary, salary.paid_amount) : null;
  const [lopAmount, setLopAmount] = React.useState(String(paidTarget ?? salary.lop_amount));
  const [lopDays, setLopDays] = React.useState(String(salary.lop_days ?? 0));
  const [reason, setReason] = React.useState("");

  const lop = Math.round(Number(lopAmount) || 0);
  const days = Math.max(0, Math.round((Number(lopDays) || 0) * 10) / 10);
  const net = netAfterLop(salary, lop);
  const problem = lopProblem(salary, lop, reason);
  const hasStatutory = salary.tds + salary.pf + salary.esi > 0;

  const save = () => {
    if (problem) return;
    adjust.mutate({ salaryId: salary.id, lopDays: days, lopAmount: lop, reason: reason.trim() }, { onSuccess: () => onClose() });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit salary — {name}, {periodLabel(salary.period)}</DialogTitle>
          <DialogDescription>
            Set loss of pay so the net is what was really paid. The booked salary expense follows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-3">Gross</dt><dd className="text-right tabular-nums text-ink">{rupee(salary.gross)}</dd>
            <dt className="text-ink-3">Net now</dt><dd className="text-right tabular-nums text-ink">{rupee(salary.net)}</dd>
            <dt className="text-ink-3">Paid from the bank</dt><dd className="text-right tabular-nums text-ink">{rupee(salary.paid_amount)}</dd>
          </dl>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Loss of pay (₹)" required htmlFor="lop-amount">
              <Input id="lop-amount" type="number" min={0} inputMode="numeric" value={lopAmount} onChange={(e) => setLopAmount(e.target.value)} />
            </FormField>
            <FormField label="LOP days" htmlFor="lop-days">
              <Input id="lop-days" type="number" min={0} step={0.5} inputMode="decimal" value={lopDays} onChange={(e) => setLopDays(e.target.value)} />
            </FormField>
          </div>
          {paidTarget !== null && lop !== paidTarget && (
            <button type="button" className="text-xs text-amber-ink hover:underline" onClick={() => setLopAmount(String(paidTarget))}>
              Set net to the amount paid ({rupee(salary.paid_amount)}) — LOP {rupee(paidTarget)}
            </button>
          )}

          <FormField label="Reason" required htmlFor="lop-reason">
            <Input id="lop-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. left on 16 Apr — full & final paid" />
          </FormField>

          <p className="text-sm text-ink-2 rounded-md bg-paper-2/60 px-3 py-2">
            New net <b className="tabular-nums">{rupee(net)}</b>
            {salary.paid_amount > 0 && net === salary.paid_amount ? " — equals what was paid, so it shows as Paid." : null}
            {salary.paid_amount > 0 && net > salary.paid_amount ? ` — ${rupee(net - salary.paid_amount)} still to pay.` : null}
          </p>
          {hasStatutory && (
            <p className="text-xs text-amber-ink">
              TDS / PF / ESI on this salary stay as booked. If they must change too, un-reconcile the bank line, then Undo and run the salary again.
            </p>
          )}
          {problem && <p className="text-xs text-rose-ink">{problem}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={adjust.isPending}>Cancel</Button>
          <Button variant="primary" loading={adjust.isPending} disabled={!!problem} onClick={save}>Save salary</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
