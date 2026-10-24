/**
 * R-1863 (decision on R-1838) — "Relink" an old one-off bank sale.
 *
 * Before R-1838, Reconcile → "Create invoice" booked every customer receipt as a ONE-OFF sale,
 * even when the money was a renewal, extra seats or a new subscription. Those bookings stay as
 * they are (no automatic data change). The bank page lists them ("Old one-off bookings (N)") and
 * this dialog moves one at a time onto what it really paid:
 *
 *   1. it says exactly what will happen (credit note on the old GST invoice, receipt removed,
 *      then the new booking) — lib/banking/credit-pay-for.ts relinkSteps;
 *   2. the operator picks the customer and what the money was for, in the same "This money is
 *      for:" step as a fresh line (CreditPayForSection with `relink`);
 *   3. one server transaction does it all (relink_bank_one_off_sale), or nothing changes.
 *
 * A booking the bank page cannot undo (books locked, other receipts, a note already on the
 * invoice) shows why and where to fix it instead (§24).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useCustomers } from "@/lib/queries/customers";
import { relinkBlocker, relinkSteps, type OldOneOffBooking } from "@/lib/banking/credit-pay-for";
import { CreditPayForSection } from "@/components/features/banking/credit-pay-for-section";

interface Props {
  txn: BankTransactionRow | null;
  booking: OldOneOffBooking | null;
  /** Relink removes a receipt — owner / accountant only (the server checks it too). */
  canRelink: boolean;
  onClose: () => void;
}

export function RelinkOneOffDialog({ txn, booking, canRelink, onClose }: Props) {
  const { data: customers } = useCustomers();
  const [saved, setSaved] = React.useState(false);
  React.useEffect(() => { setSaved(false); }, [txn?.id]);
  const open = Boolean(txn && booking);
  const blocker = booking ? relinkBlocker(booking) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle>Relink this bank line</DialogTitle>
          <DialogDescription>
            {txn ? `${formatDate(txn.txn_date)} · ${rupee(txn.credit)} · ${txn.description ?? ""}` : ""}
          </DialogDescription>
        </DialogHeader>

        {txn && booking && (
          <div className="space-y-3 min-w-0">
            {!saved && (
              <p className="text-sm text-ink-2 break-words">
                Booked before as a one-off sale{" "}
                <Link href={`/quotes/${encodeURIComponent(booking.quote_id)}` as never} className="font-mono underline hover:no-underline">{booking.quote_id}</Link>
                {booking.customer_name ? <> for <b>{booking.customer_name}</b></> : null}
                {booking.product ? <> ({booking.product})</> : null}
                {booking.invoice_id ? <> with invoice{" "}
                  <Link href={`/invoices/${encodeURIComponent(booking.invoice_id)}` as never} className="font-mono underline hover:no-underline">{booking.invoice_id}</Link></> : null}.
              </p>
            )}

            {blocker ? (
              <div role="alert" className="rounded-md border border-rose/40 bg-rose-soft/30 p-3 space-y-2">
                <p className="text-sm text-ink">This line cannot be relinked yet. {blocker.text}</p>
                <Link href={blocker.href as never}><Button size="sm" variant="default">{blocker.action}</Button></Link>
              </div>
            ) : !canRelink ? (
              <p role="note" className="rounded-md border border-hairline bg-paper-2/40 p-3 text-sm text-ink-2">
                Relinking removes the old receipt, so only an owner or accountant can do it. Ask them to press Relink on this line.
              </p>
            ) : (
              <>
                {!saved && (
                  <section aria-labelledby="relink-steps-h" className="rounded-md border border-hairline bg-paper p-3">
                    <p id="relink-steps-h" className="text-xs font-semibold text-ink-2 inline-flex items-center gap-1">
                      <Icon name="info" size={12} /> What will happen
                    </p>
                    <ol className="mt-1.5 list-decimal pl-5 space-y-1 text-sm text-ink-2">
                      {relinkSteps(booking).map((s, i) => <li key={i} className="break-words">{s}</li>)}
                    </ol>
                  </section>
                )}
                <CreditPayForSection
                  transaction={txn}
                  customers={customers ?? []}
                  pickedCustomerId={booking.customer_id}
                  relink={booking}
                  onSaved={() => setSaved(true)}
                  onDone={onClose}
                />
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
