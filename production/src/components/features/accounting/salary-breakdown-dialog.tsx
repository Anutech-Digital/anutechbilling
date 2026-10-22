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
          <DialogDescription>How the net {rupee(record.net)} is worked out</DialogDescription>
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
            These lines do not add up to the net — the record may have been edited by hand. Check it in Payroll → ⋯ → Edit salary.
          </p>
        )}
        {b.employerCost > 0 && (
          <p className="text-xs text-ink-3">+ Employer PF / ESI {rupee(b.employerCost)} — the company's cost, not deducted from salary.</p>
        )}

        <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-xs text-ink-2 space-y-0.5">
          <div className="flex justify-between"><span>Paid</span><span className="tabular-nums">{rupee(paid)}</span></div>
          <div className="flex justify-between"><span>Balance due</span><span className={`tabular-nums ${due > 0 ? "text-rose" : ""}`}>{rupee(due)}</span></div>
          <div className="text-ink-3">
            {record.paid_status === "paid" ? "Fully paid" : record.paid_status === "partial" ? "Partly paid" : "Not paid yet — reconciled when it leaves the bank"}
            {record.reconciled_txn_id ? " · reconciled to a bank line" : ""}
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
