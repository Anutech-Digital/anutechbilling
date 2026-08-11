/**
 * BulkMarkPaidDialog — settle several operating expenses (payables) at once.
 *
 * The "clear this month's payables" flow. Captures ONE paid-date + method for
 * the whole batch and marks them all paid in a single update. Non-cash only
 * (bank / UPI / card / cheque) — cash/petty-cash needs a per-expense account,
 * so those stay on the single MarkPaidDialog. Payroll/statutory rows are never
 * passed in by the caller.
 */
"use client";

import * as React from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { rupee } from "@/lib/utils";
import { useBulkMarkExpensesPaid, type Expense } from "@/lib/queries/expenses";

// Cash is deliberately excluded — petty-cash needs a per-expense account.
const BULK_METHODS = ["bank_transfer", "upi", "card", "cheque"] as const;

export function BulkMarkPaidDialog({
  expenses, onClose, onDone,
}: {
  expenses: Expense[];
  onClose: () => void;
  onDone: () => void;
}) {
  const bulk = useBulkMarkExpensesPaid();
  const today = new Date().toISOString().slice(0, 10);
  const [paidDate, setPaidDate] = React.useState<string>(today);
  const [method, setMethod] = React.useState<string>("bank_transfer");

  const total = expenses.reduce((s, e) => s + (e.amount ?? 0), 0);

  async function submit() {
    await bulk.mutateAsync({
      ids: expenses.map((e) => e.id),
      paid_date: paidDate,
      payment_method: method,
    });
    onDone();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {expenses.length} {expenses.length === 1 ? "expense" : "expenses"} paid</DialogTitle>
          <DialogDescription>
            Total <b className="text-ink">{rupee(total)}</b> — one date &amp; payment method for the whole batch.
            Reconcile them against their bank lines in Banking afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Paid on" htmlFor="bulk_paid_date">
            <Input id="bulk_paid_date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
          </FormField>

          <FormField label="Paid by" htmlFor="bulk_paid_method">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="bulk_paid_method"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BULK_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-ink-3 mt-1">
              Paying by cash? Use each row&apos;s own <b>Mark paid</b> so the right petty-cash account is deducted.
            </p>
          </FormField>

          {/* A quick, scannable list of what's about to be settled. */}
          <div className="max-h-40 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-[12px]">
            {expenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="truncate text-ink-2">
                  {e.category}{e.vendor_name ? ` · ${e.vendor_name}` : ""}
                </span>
                <span className="font-mono tabular-nums text-ink shrink-0">{rupee(e.amount)}</span>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={bulk.isPending} onClick={submit}>
            Mark {rupee(total)} paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
