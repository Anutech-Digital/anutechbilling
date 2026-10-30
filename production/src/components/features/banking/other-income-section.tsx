/**
 * R-2095 (30 Oct 2026, September reconcile): Reconcile → money in → "Other / manual" could only mark
 * an interest credit reconciled — the P&L never saw it. "Interest received" books the line as other
 * income (P&L → Other income) and reconciles it, one transaction.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useBookOtherIncome, type OtherIncomeHead } from "@/lib/queries/bank-other-income";

/** The narration says interest (INT.PD, INTEREST, FD INT …) — then "Interest received" is picked first. */
export function looksLikeInterest(description: string | null | undefined): boolean {
  return /\b(int\.?\s?pd|interest|int\s+cr|fd\s+int|sb\s+int|int\.?\s+credit)\b/i.test(description ?? "");
}

export function OtherIncomeSection({ transaction, onDone }: { transaction: BankTransactionRow; onDone: () => void }) {
  const book = useBookOtherIncome();
  const [head, setHead] = React.useState<OtherIncomeHead>(looksLikeInterest(transaction.description) ? "interest" : "other");
  React.useEffect(() => { setHead(looksLikeInterest(transaction.description) ? "interest" : "other"); }, [transaction.id, transaction.description]);
  const amount = transaction.credit ?? 0;

  async function submit() {
    try {
      await book.mutateAsync({ transactionId: transaction.id, head });
      onDone();
    } catch { /* the hook toasts */ }
  }

  return (
    <section aria-label="Income that is not a sale" className="rounded-md border border-emerald/40 bg-emerald-soft/20 p-3 space-y-2">
      <p className="text-xs font-semibold text-ink-2">Interest or other income?</p>
      <p className="text-xs text-ink-3 leading-relaxed">
        Interest on an FD or savings account is income, not a sale — it goes to the P&amp;L as <b>Other income</b>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="What this income is">
        {([["interest", "Interest received"], ["other", "Other income"]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={head === k} onClick={() => setHead(k)}
            className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${head === k ? "border-emerald bg-emerald/10 text-ink" : "border-hairline text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>
      <Button size="sm" variant="primary" icon="check" onClick={submit} loading={book.isPending} disabled={book.isPending || amount <= 0}>
        Book {rupee(amount)} as {head === "interest" ? "interest received" : "other income"}
      </Button>
    </section>
  );
}
