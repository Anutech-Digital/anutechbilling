/**
 * UnreconcileDialog — the confirm step before a bank line is freed, saying what the line
 * was booked as and what freeing it leaves behind.
 *
 * A line booked with "Invoice banao & reconcile" offers to undo that sale too, ticked by
 * default: without it the invoice stays, and booking the line again counts the same money
 * twice. An issued invoice is reversed with a full credit note (a draft is voided) — an
 * issued tax invoice cannot vanish from the series (migration 20260927140000).
 * R-1999: a project-receipt line lists every kist it paid (bank + TDS) and what goes back; the
 * invoices stay, due again (D3). A refusal shows with the page to fix it on.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import {
  useUnreconcileImpact, useUnreconcileBankTxn, vendorUndoLegLine, blockHrefLabel, projectUndoRowLine,
  type VendorUndoPreview, type ProjectUndoPreview,
} from "@/lib/queries/unreconcile";

/**
 * R-1920: a vendor-payment line — every leg it reverses, from the server's dry run of the same
 * un-match, so the owner sees it before the click. A refusal (later payment, used advance,
 * deposited TDS) shows instead of the confirm, with the page to fix it on.
 */
function VendorUndoPreviewBlock({ preview }: { preview: VendorUndoPreview }) {
  return (
    <div className="space-y-3 text-sm text-ink-2">
      <p>
        This line paid <b>{preview.vendor_name ?? "a vendor"}</b>. {preview.blocked ? "Un-reconciling it would:" : "Un-reconciling it will:"}
      </p>
      <ul className="space-y-1.5" aria-label="What goes back">
        {preview.legs.map((leg) => (
          <li key={leg.id} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />
            <span>
              {vendorUndoLegLine(leg)}
              {!leg.removed && leg.doc_type !== "advance" ? (
                <> · <Link href={leg.href as never} className="text-amber-ink underline">view</Link></>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {preview.blocked ? (
        <div role="alert" className="rounded-md border border-amber/50 bg-amber-soft/25 p-3 text-[13px] leading-snug">
          <b className="block">This line cannot be un-reconciled yet.</b>
          {preview.block_message}
        </div>
      ) : (
        <p className="text-xs text-ink-3">The bank line goes back to &quot;Unmatched&quot;.</p>
      )}
    </div>
  );
}

/**
 * R-1999: a project-receipt line — every kist it paid, from the server's dry run of the same
 * un-reconcile. The whole booking goes back in one step (payments, TDS, kist status); each invoice
 * stays and is due again (Pardeep's D3: no credit note, the GST series is never broken).
 */
function ProjectUndoPreviewBlock({ preview }: { preview: ProjectUndoPreview }) {
  return (
    <div className="space-y-3 text-sm text-ink-2">
      <p>
        This line paid <b>{preview.project_title ?? "a project"}</b>
        {preview.customer_name ? <> ({preview.customer_name})</> : null}.{" "}
        {preview.rows.length === 0 ? "No project payment is left on it — only the bank line is freed."
          : preview.blocked ? "Un-reconciling it would:" : "Un-reconciling it will:"}
      </p>
      <ul className="space-y-1.5" aria-label="What goes back">
        {preview.rows.map((row) => (
          <li key={row.milestone_id} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />
            <span>
              {projectUndoRowLine(row)} · <Link href={row.href as never} className="text-amber-ink underline">view</Link>
            </span>
          </li>
        ))}
      </ul>
      {preview.blocked ? (
        <div role="alert" className="rounded-md border border-amber/50 bg-amber-soft/25 p-3 text-[13px] leading-snug">
          <b className="block">This line cannot be un-reconciled yet.</b>
          {preview.block_message}
        </div>
      ) : (
        <p className="text-xs text-ink-3">
          No credit note — each invoice keeps its number. The bank line goes back to &quot;Unmatched&quot;, ready to book to the right project.
        </p>
      )}
    </div>
  );
}

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
          <ProjectUndoPreviewBlock preview={impact.preview} />
        ) : impact?.kind === "vendor-payment" ? (
          <VendorUndoPreviewBlock preview={impact.preview} />
        ) : (
          <p className="text-sm text-ink-2">
            The line goes back to &quot;Unmatched&quot;. Any capital / loan, tax challan or prepaid advance created from this line is removed too;
            an expense or salary entry stays, only its bank link is removed.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          {impact?.kind === "advance" && impact.usedOrRefunded > 0 ? null
          : (impact?.kind === "vendor-payment" || impact?.kind === "project") && impact.preview.blocked ? (
            /* R-1920: refused — the next step is fixing what depends on it, not un-reconciling. */
            impact.preview.block_href ? (
              <Button asChild variant="primary">
                <Link href={impact.preview.block_href as never} onClick={onClose}>{blockHrefLabel(impact.preview.block_href)}</Link>
              </Button>
            ) : null
          ) : (
            <Button type="button" variant="danger" loading={unreconcile.isPending} disabled={isLoading} onClick={confirm}>
              Un-reconcile{impact?.kind === "bank-sale" && undoSale ? " & sale palto" : impact?.kind === "advance" ? " & remove advance" : impact?.kind === "vendor-payment" || impact?.kind === "project" ? " & reverse" : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
