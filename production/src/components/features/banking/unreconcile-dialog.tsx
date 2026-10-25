/**
 * UnreconcileDialog — the confirm step before a bank line is freed, saying what the line
 * was booked as and what freeing it leaves behind.
 *
 * A line booked with "Invoice banao & reconcile" offers to undo that sale too, ticked by
 * default: without it the invoice stays, and booking the line again counts the same money
 * twice. An issued invoice is reversed with a full credit note (a draft is voided) — an
 * issued tax invoice cannot vanish from the series (migration 20260927140000).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useUnreconcileImpact, useUnreconcileBankTxn } from "@/lib/queries/unreconcile";

export function UnreconcileDialog({ txn, onClose }: { txn: BankTransactionRow | null; onClose: () => void }) {
  const { data: impact, isLoading } = useUnreconcileImpact(txn);
  const unreconcile = useUnreconcileBankTxn();
  const [undoSale, setUndoSale] = React.useState(true);

  React.useEffect(() => { setUndoSale(true); }, [txn?.id]);

  async function confirm() {
    if (!txn) return;
    await unreconcile.mutateAsync({ txnId: txn.id, undoSale: impact?.kind === "bank-sale" && undoSale });
    onClose();
  }

  const amount = txn ? (txn.credit > 0 ? txn.credit : txn.debit) : 0;

  return (
    <Dialog open={!!txn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Un-reconcile this line?</DialogTitle>
          <DialogDescription>
            {txn ? `${formatDate(txn.txn_date)} · ${rupee(amount)} · ${txn.description ?? ""}` : ""}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="py-4 text-sm text-ink-3">Checking what this line is linked to…</p>
        ) : impact?.kind === "bank-sale" ? (
          <div className="space-y-3 text-sm text-ink-2">
            <p>
              When this line was reconciled, {impact.invoiceId ? <>invoice <b className="font-mono">{impact.invoiceId}</b> and </> : null}
              a receipt of {rupee(impact.amount)} were created.
            </p>
            <label className="flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/25 p-3">
              <input type="checkbox" checked={undoSale} onChange={(e) => setUndoSale(e.target.checked)} className="mt-1" />
              <span className="text-[13px] leading-snug">
                <b>Also reverse that sale</b> — an issued invoice gets a full credit note (the invoice stays with nothing due; a draft is voided), and the receipt is removed.
                <span className="block text-xs text-ink-3 mt-0.5">
                  If this line is now to be booked as something else (e.g. a project payment), keep this ticked — otherwise the same money is counted twice in revenue.
                </span>
              </span>
            </label>
          </div>
        ) : impact?.kind === "advance" ? (
          impact.usedOrRefunded > 0 ? (
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                This line is {impact.customerName ?? "a customer"}&apos;s advance of {rupee(impact.amount)}, and {rupee(impact.usedOrRefunded)} of it
                is already used on a later payment (or refunded), so it cannot be taken back.
              </p>
              <p className="text-xs text-ink-3">
                Next step: on <Link href={"/payments" as never} className="text-amber-ink underline">Payments</Link>, delete or refund the payment that used this credit — the credit opens again — then un-reconcile this line.
              </p>
            </div>
          ) : (
            <p className="text-sm text-ink-2">
              This line is {impact.customerName ?? "a customer"}&apos;s advance of {rupee(impact.amount)}. Un-reconciling takes it back:
              the receipt{impact.voucherNo ? <> <span className="font-mono">{impact.voucherNo}</span></> : null} is removed (its number is kept as cancelled)
              and the customer&apos;s {rupee(impact.amount)} credit goes too.
            </p>
          )
        ) : impact?.kind === "receipt" ? (
          <p className="text-sm text-ink-2">
            This line is linked to a receipt of {rupee(impact.amount)}{impact.invoiceId ? <> (invoice <span className="font-mono">{impact.invoiceId}</span>)</> : null}.
            The receipt was recorded separately, so it stays — only the bank line is freed.
          </p>
        ) : impact?.kind === "project" ? (
          <p className="text-sm text-ink-2">
            This line is linked to the {rupee(impact.amount)} payment for &quot;{impact.milestoneLabel}&quot; of <b>{impact.projectTitle}</b>
            {impact.invoiceId ? <> (invoice <span className="font-mono">{impact.invoiceId}</span>)</> : null}.
            Only the bank line is freed — the project payment stays. If that payment was wrong, remove it from the{" "}
            <Link href={`/projects/${impact.projectId}`} className="text-amber-ink underline">project page</Link>.
          </p>
        ) : (
          <p className="text-sm text-ink-2">
            The line goes back to &quot;Unmatched&quot;. Any capital / loan, tax challan or prepaid advance created from this line is removed too;
            an expense or salary entry stays, only its bank link is removed.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          {impact?.kind === "advance" && impact.usedOrRefunded > 0 ? null : (
            <Button type="button" variant="danger" loading={unreconcile.isPending} disabled={isLoading} onClick={confirm}>
              Un-reconcile{impact?.kind === "bank-sale" && undoSale ? " & sale palto" : impact?.kind === "advance" ? " & remove advance" : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
