/**
 * SalaryBreakdownDialog — click a Net on Payroll to see how it was reached.
 *
 * Salary, loss of pay, incentive, each deduction, net (lib/accounting/salary-breakdown.ts),
 * then where the money stands: paid so far, status, and the note the record was booked with
 * (e.g. "₹35,000 salary + ₹5,00,000 incentive — deal commission").
 */
"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import { formatMonthLabel } from "@/lib/dates/ist";
import { salaryBreakdown, type SalaryRecordLike } from "@/lib/accounting/salary-breakdown";

export interface SalaryRecordForBreakdown extends SalaryRecordLike {
  period: string;
  pay_date?: string | null;
  paid_amount?: number | null;
  paid_status?: string | null;
  notes?: string | null;
  reconciled_txn_id?: string | null;
}

const monthLabel = (period: string) => formatMonthLabel(period, { month: "long" });

export function SalaryBreakdownDialog({ name, record, onClose }: {
  name: string;
  record: SalaryRecordForBreakdown | null;
  onClose: () => void;
}) {
  if (!record) return null;
  const b = salaryBreakdown(record);
  const paid = Math.round(record.paid_amount ?? 0);
  const due = Math.max(0, Math.round(record.net) - paid);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{name} · {monthLabel(record.period)}</DialogTitle>
          <DialogDescription>Net {rupee(record.net)} kaise bana</DialogDescription>
        </DialogHeader>

        <table className="w-full text-sm tabular-nums">
          <tbody>
            {b.lines.map((l, i) => (
              <tr key={i} className={l.sign === "=" ? "border-t border-hairline font-semibold" : ""}>
                <td className="py-1.5 pr-2 text-ink-3 w-5">{l.sign}</td>
                <td className="py-1.5 text-ink-2">
                  {l.label}{l.note && <span className="text-xs text-ink-3"> · {l.note}</span>}
                </td>
                <td className={`py-1.5 text-right ${l.sign === "−" ? "text-rose" : "text-ink"}`}>{rupee(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!b.addsUp && (
          <p className="text-xs text-rose">
            In lines ka jod net se nahi milta — record haath se badla gaya ho sakta hai. Payroll mein ⋯ → Edit salary se dekh lo.
          </p>
        )}
        {b.employerCost > 0 && (
          <p className="text-xs text-ink-3">+ Employer PF / ESI {rupee(b.employerCost)} — company ka kharcha, salary se nahi kata.</p>
        )}

        <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-xs text-ink-2 space-y-0.5">
          <div className="flex justify-between"><span>Diya ja chuka</span><span className="tabular-nums">{rupee(paid)}</span></div>
          <div className="flex justify-between"><span>Baaki</span><span className={`tabular-nums ${due > 0 ? "text-rose" : ""}`}>{rupee(due)}</span></div>
          <div className="text-ink-3">
            {record.paid_status === "paid" ? "Poora diya gaya" : record.paid_status === "partial" ? "Aadha diya gaya" : "Abhi diya nahi — bank se jaane par reconcile hoga"}
            {record.reconciled_txn_id ? " · bank line se reconciled" : ""}
            {record.pay_date ? ` · ${formatDate(record.pay_date)}` : ""}
          </div>
        </div>

        {record.notes && (
          <p className="text-xs text-ink-3 leading-snug whitespace-pre-line"><b className="text-ink-2">Note:</b> {record.notes}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
