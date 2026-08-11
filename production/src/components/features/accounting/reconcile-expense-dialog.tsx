/**
 * ReconcileExpenseDialog — expense-first reconcile.
 *
 * Given a PAID (but not yet bank-verified) expense, list the tenant's unmatched
 * bank debit lines — ranked by how close their amount + date are to the expense
 * — and let the operator match one in a click. Matching reuses the same
 * useReconcileTransaction mutation the Banking page uses, so it sets the bank
 * line's matched_to + the expense's reconciled_txn_id exactly the same way.
 * Once matched the expense shows "✓ Paid" (bank-verified).
 */
"use client";

import * as React from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate } from "@/lib/utils";
import { type Expense } from "@/lib/queries/expenses";
import { useUnmatchedBankDebits, useReconcileTransaction, type UnmatchedDebit } from "@/lib/queries/bank";

/** Rank: exact-amount first, then nearest amount, then nearest date. */
function rank(a: UnmatchedDebit, b: UnmatchedDebit, amount: number, date: string): number {
  const ad = Math.abs(a.debit - amount), bd = Math.abs(b.debit - amount);
  if (ad !== bd) return ad - bd;
  const at = Math.abs(+new Date(a.txn_date) - +new Date(date));
  const bt = Math.abs(+new Date(b.txn_date) - +new Date(date));
  return at - bt;
}

export function ReconcileExpenseDialog({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const { data: lines, isLoading } = useUnmatchedBankDebits();
  const reconcile = useReconcileTransaction();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const ranked = React.useMemo(() => {
    const all = [...(lines ?? [])].sort((a, b) => rank(a, b, expense.amount, expense.expense_date));
    return all.slice(0, 40);
  }, [lines, expense.amount, expense.expense_date]);

  async function match(txnId: string) {
    setBusyId(txnId);
    try {
      await reconcile.mutateAsync({
        transactionId: txnId,
        matchedToType: "expense",
        matchedToId: expense.id,
        confidence: "manual",
      });
      onClose();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Reconcile with a bank line</DialogTitle>
          <DialogDescription>
            {expense.vendor_name ? `${expense.vendor_name} · ` : ""}{rupee(expense.amount)}
            {expense.description ? ` — ${expense.description}` : ""} · {formatDate(expense.expense_date)}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="py-6 text-center text-sm text-ink-3">Loading bank lines…</p>
        ) : ranked.length === 0 ? (
          <EmptyState
            icon="refresh"
            title="No unmatched bank lines"
            body="Import your bank statement in Banking first — then the matching debit will show up here to reconcile."
          />
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto divide-y divide-hairline -mx-1">
            {ranked.map((t) => {
              const exact = t.debit === expense.amount;
              return (
                <li key={t.id} className="flex items-center gap-3 px-1 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-ink tabular-nums">{rupee(t.debit)}</span>
                      {exact && <span className="rounded-full bg-emerald/10 text-emerald px-1.5 py-0.5 text-[10px] font-medium">exact match</span>}
                    </div>
                    <div className="text-[11px] text-ink-3 truncate">
                      {formatDate(t.txn_date)} · {t.account_name}{t.description ? ` · ${t.description}` : ""}
                    </div>
                  </div>
                  <Button variant={exact ? "primary" : "default"} className="h-7 px-2.5 py-0 text-[12px] shrink-0"
                    loading={busyId === t.id} onClick={() => match(t.id)}>
                    Reconcile
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
