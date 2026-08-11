/**
 * MarkPaidDialog — settle an unpaid expense (payable).
 *
 * Captures WHEN it was paid, HOW (payment method), and — for a cash payment —
 * which petty-cash account to debit. The cash movement is created only now (via
 * useMarkExpensePaid), so cash-in-hand moves the moment the money actually left,
 * never at bill time. Reused by the Expenses list and the expense detail dialog.
 */
"use client";

import * as React from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { rupee } from "@/lib/utils";
import { PAYMENT_METHODS, useMarkExpensePaid, type Expense } from "@/lib/queries/expenses";
import { useBankAccounts } from "@/lib/queries/bank";

export function MarkPaidDialog({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const markPaid = useMarkExpensePaid();
  const today = new Date().toISOString().slice(0, 10);
  const [paidDate, setPaidDate] = React.useState<string>(today);
  const [method, setMethod] = React.useState<string>(expense.payment_method ?? "bank_transfer");
  const { data: bankAccounts } = useBankAccounts();
  const cashAccounts = (bankAccounts ?? []).filter((a) => a.account_type === "cash");
  const [pettyCashAccountId, setPettyCashAccountId] = React.useState<string>("");

  async function submit() {
    await markPaid.mutateAsync({
      id: expense.id,
      paid_date: paidDate,
      payment_method: method,
      pettyCashAccountId: method === "cash" ? (pettyCashAccountId || null) : null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as paid</DialogTitle>
          <DialogDescription>
            {expense.vendor_name ? `${expense.vendor_name} · ` : ""}{rupee(expense.amount)}
            {expense.description ? ` — ${expense.description}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Paid on" htmlFor="paid_date">
            <Input id="paid_date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
          </FormField>

          <FormField label="Paid by" htmlFor="paid_method">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="paid_method"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {method === "cash" && cashAccounts.length > 0 && (
            <FormField label="Paid from petty cash" htmlFor="paid_petty">
              <Select value={pettyCashAccountId || "none"} onValueChange={(v) => setPettyCashAccountId(v === "none" ? "" : v)}>
                <SelectTrigger id="paid_petty"><SelectValue placeholder="Don't deduct from petty cash" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Don&apos;t deduct from petty cash</SelectItem>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-ink-3 mt-1">Cash-in-hand se ye amount ab minus hoga.</p>
            </FormField>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={markPaid.isPending} onClick={submit}>
            Mark {rupee(expense.amount)} paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
