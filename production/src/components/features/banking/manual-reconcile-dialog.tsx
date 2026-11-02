/**
 * ManualReconcileDialog — R-2361: the confirm behind "Mark reconciled manually".
 *
 * Shows the line (date · amount · description), needs a reason (saved on the line and in the
 * activity log), and can pair the line with its reversal — an opposite line on the same account
 * for the same amount, still open, within 30 days — so a failed / returned payment is closed as a
 * linked pair. Cancel changes nothing. The save is one RPC (lib/banking/manual-reconcile).
 */
"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, rupee } from "@/lib/utils";
import {
  lineAmount, reasonProblem, useReconcileManually, useReversalCandidates, MAX_REASON_CHARS,
  type LineLike,
} from "@/lib/banking/manual-reconcile";

export function ManualReconcileDialog({ txn, open, onCancel, onDone }: {
  txn: LineLike | null;
  open: boolean;
  onCancel: () => void;
  /** After a successful save (the drawer closes). */
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [reversalId, setReversalId] = React.useState<string>("");
  const [touched, setTouched] = React.useState(false);
  const save = useReconcileManually();
  const { data: candidates, isLoading } = useReversalCandidates(txn, open);

  React.useEffect(() => { if (open) { setReason(""); setReversalId(""); setTouched(false); } }, [open, txn?.id]);

  const problem = reasonProblem(reason);
  const amount = txn ? lineAmount(txn) : 0;
  const list = candidates ?? [];

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (!txn || problem) return;
    try {
      await save.mutateAsync({ transactionId: txn.id, reason, reversalId: reversalId || null });
      onDone();
    } catch { /* hook toasts the error */ }
  }

  return (
    <Dialog open={open && !!txn} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="md:!max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Mark this line reconciled without an entry?</DialogTitle>
            <DialogDescription>
              {txn ? `${formatDate(txn.txn_date)} · ${txn.credit > 0 ? "Money in" : "Money out"} ${rupee(amount)} · ${txn.description ?? ""}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label htmlFor="manual-reconcile-reason" className="block text-xs font-semibold text-ink-2 mb-1">
                Reason (required)
              </label>
              <Textarea
                id="manual-reconcile-reason"
                rows={3}
                maxLength={MAX_REASON_CHARS}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="e.g. RTGS failed, the bank returned it on 12 Oct"
                error={touched && problem ? problem : undefined}
                aria-required="true"
              />
              <p className="mt-1 text-xs text-ink-3">Saved on the line and in the activity log, so anyone can see later why it needs no entry.</p>
            </div>

            <fieldset>
              <legend className="text-xs font-semibold text-ink-2 mb-1">Pair with a reversal line (optional)</legend>
              {isLoading ? (
                <p className="text-xs text-ink-3">Looking for the opposite line…</p>
              ) : list.length === 0 ? (
                <p className="text-xs text-ink-3">
                  No open {txn && txn.credit > 0 ? "money-out" : "money-in"} line of {rupee(amount)} on this account within 30 days.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <label className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${reversalId === "" ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                    <input type="radio" name="manual-reversal" checked={reversalId === ""} onChange={() => setReversalId("")} className="mt-1" />
                    <span className="text-[13px]">Not a reversal — this line only</span>
                  </label>
                  {list.map((c) => (
                    <label key={c.id} className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer ${reversalId === c.id ? "border-indigo bg-indigo/10" : "border-hairline"}`}>
                      <input type="radio" name="manual-reversal" checked={reversalId === c.id} onChange={() => setReversalId(c.id)} className="mt-1" />
                      <span className="text-[13px] leading-snug min-w-0">
                        <b>{formatDate(c.txn_date)} · {c.credit > 0 ? "+" : "−"}{rupee(lineAmount(c))}</b>
                        <span className="block text-xs text-ink-3 break-words">{c.description}</span>
                      </span>
                    </label>
                  ))}
                  {reversalId && <p className="text-xs text-ink-3">Both lines are reconciled together; un-reconciling either one frees both.</p>}
                </div>
              )}
            </fieldset>
          </div>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(problem)} title={problem ?? undefined}>
              {reversalId ? "Reconcile both lines" : "Mark reconciled"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
