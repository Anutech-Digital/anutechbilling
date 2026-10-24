"use client";

/**
 * R-455: end a real subscription — the customer is leaving.
 *
 * Different from "Delete (wrong entry)", which removes a subscription that should never
 * have existed. Cancelling keeps everything (quote, payments, invoices, history) and takes
 * the subscription out of MRR and renewals from its last day.
 *
 * "Clear the ₹X still due" is offered only when something is due. It is ON when the
 * caller knows the money was refunded (Payments → Refund → "customer leaving?"), and OFF
 * otherwise — a customer who used the service and has not paid still owes it.
 *
 * R-1711: the part of that due an OPEN GST invoice still asks for is never cleared here —
 * zeroing it left the subscription saying "nothing owed" while INV-0013 kept asking for
 * ₹18,232. An issued invoice is reduced only by a credit note on it (CGST s.34), so the
 * dialog names the invoice and offers "Issue credit note for the unused part"; once that note
 * lands, what is left is clearable. lib/subscriptions/cancel-due.ts is the split;
 * cancel_subscription() applies the same rule on the server.
 */
import * as React from "react";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/label";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import type { Subscription } from "@/lib/supabase/database.types";
import { useCancelSubscription, useSubscriptionInvoices } from "@/lib/queries/subscriptions";
import { cancelDueSplit } from "@/lib/subscriptions/cancel-due";
import { IssueCreditNoteDialog } from "@/components/features/invoices/issue-credit-note-dialog";

/** "Cancelled on 9 Oct 2026 — Refunded, customer left · ₹956 due cleared" for the panel.
 *  R-489: the cancel columns (20261009151000) are typed in database.generated.ts now. */
export function cancelNote(c: Subscription): string {
  return "Cancelled"
    + (c.cancelled_at ? ` on ${formatDate(c.cancelled_at)}` : "")
    + (c.cancel_reason ? ` — ${c.cancel_reason}` : "")
    + ((c.cancel_due_cleared ?? 0) > 0 ? ` · ${rupee(c.cancel_due_cleared ?? 0)} due cleared` : "");
}

export function CancelSubscriptionDialog({ sub, open, onOpenChange, clearDueDefault = false, defaultReason = "" }: {
  sub: Pick<Subscription, "id" | "customer_name" | "plan" | "outstanding_amount" | "start_date" | "quote_id" | "renewal_quote_id">;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** True when the payment was just refunded — the due is not real any more. */
  clearDueDefault?: boolean;
  defaultReason?: string;
}) {
  const cancel = useCancelSubscription();
  const due = sub.outstanding_amount ?? 0;
  /* R-1711: which part of the due an open invoice still asks for. Read only when there is a due. */
  const invoicesQ = useSubscriptionInvoices(sub, open && due > 0);
  const split = cancelDueSplit(due, invoicesQ.data ?? []);
  const invoicesKnown = due <= 0 || !!invoicesQ.data || invoicesQ.isError;   // the server applies the same rule
  const [cnFor, setCnFor] = React.useState<string | null>(null);
  const cnInvoice = cnFor ? (invoicesQ.data ?? []).find((i) => i.id === cnFor) ?? null : null;
  const cnDue = cnFor ? split.openInvoices.find((i) => i.id === cnFor)?.due ?? 0 : 0;
  const [lastDay, setLastDay] = React.useState(istToday());
  const [reason, setReason]   = React.useState(defaultReason);
  const [clearDue, setClearDue] = React.useState(clearDueDefault);
  React.useEffect(() => {
    if (!open) return;
    setLastDay(istToday());
    setReason(defaultReason);
    setClearDue(clearDueDefault);
  }, [open, sub.id, clearDueDefault, defaultReason]);

  const reasonOk = reason.trim().length >= 5;
  const dateOk = !!lastDay && (!sub.start_date || lastDay >= sub.start_date.slice(0, 10));

  const onConfirm = () => {
    if (!reasonOk || !dateOk) return;
    cancel.mutate(
      { id: sub.id, lastDay, reason: reason.trim(), clearDue: split.clearable > 0 && clearDue },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="font-serif text-xl text-ink">Cancel subscription</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {sub.customer_name} · {sub.plan}. It leaves MRR and renewals after the last day.
          Nothing is deleted — the quote, payments and invoices stay.
        </DialogDescription>

        <div className="mt-4 space-y-3">
          <FormField label="Last day of service" htmlFor="cancel-sub-last-day" required>
            <Input
              id="cancel-sub-last-day"
              name="last_day"
              type="date"
              value={lastDay}
              min={sub.start_date?.slice(0, 10) ?? undefined}
              onChange={(e) => setLastDay(e.target.value)}
            />
          </FormField>
          {!dateOk && lastDay && (
            <p className="text-2xs text-rose">Pick a date on or after the start ({sub.start_date?.slice(0, 10)}).</p>
          )}
          <FormField label="Reason (at least 5 characters)" htmlFor="cancel-sub-reason" required>
            <Textarea id="cancel-sub-reason" name="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer moved to another provider" />
          </FormField>
          {due > 0 && !invoicesKnown && (
            <p className="text-2xs text-ink-3">Checking this subscription&apos;s invoices…</p>
          )}
          {/* R-1711: an open invoice holds (part of) the due — a credit note, not a clear. */}
          {split.onInvoices > 0 && (
            <div role="status" className="rounded-md border border-amber/40 bg-amber-soft/50 px-3 py-2 text-2xs leading-relaxed text-amber-ink">
              <p>
                <b>{rupee(split.onInvoices)}</b> of the due is on open GST invoice{split.openInvoices.length === 1 ? "" : "s"}{" "}
                <b className="font-mono">{split.openInvoices.map((i) => i.id).join(", ")}</b>. Cancelling does not
                change {split.openInvoices.length === 1 ? "that invoice" : "those invoices"} — if they will not pay for
                the unused part, reduce it with a credit note (CGST §34). If they still have to pay, leave it as it is.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {split.openInvoices.map((i) => (
                  <Button key={i.id} type="button" size="sm" variant="default" icon="receipt" onClick={() => setCnFor(i.id)}>
                    Issue credit note for the unused part{split.openInvoices.length > 1 ? ` · ${i.id}` : ""}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {split.clearable > 0 && (
            <label className="flex items-start gap-2 text-sm text-ink-2">
              <Checkbox checked={clearDue} onCheckedChange={(v) => setClearDue(v === true)} className="mt-0.5" />
              <span>
                {split.onInvoices > 0
                  ? <>Clear the {rupee(split.clearable)} not on any invoice</>
                  : <>Clear the {rupee(split.clearable)} still shown as due</>}
                <span className="block text-2xs text-ink-3">
                  Tick only if they owe nothing (for example, the payment was refunded). Leave it off if they still have to pay.
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
            Keep it
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!reasonOk || !dateOk || !invoicesKnown} loading={cancel.isPending}>
            Cancel subscription
          </Button>
        </DialogFooter>
      </DialogContent>
      {cnFor && (
        <IssueCreditNoteDialog
          open={!!cnFor}
          onOpenChange={(v) => { if (!v) setCnFor(null); }}
          invoiceId={cnFor}
          customerName={cnInvoice?.customer_name ?? sub.customer_name}
          netPayable={cnDue}
          taxRate={cnInvoice?.tax_rate ?? null}
          interState={cnInvoice?.inter_state ?? null}
          isExport={(cnInvoice?.tax_rate ?? 18) === 0}
          invoiceDate={cnInvoice?.invoice_date ?? null}
          defaultReasonCode="cancellation"
        />
      )}
    </Dialog>
  );
}
