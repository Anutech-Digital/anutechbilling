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
import { useCancelSubscription } from "@/lib/queries/subscriptions";

/** Columns added by 20261009151000 — not in database.generated.ts yet (locked by R-482 at ship time). */
type CancelFields = { cancelled_at?: string | null; cancel_reason?: string | null; cancel_due_cleared?: number | null };

/** "Cancelled on 9 Oct 2026 — Refunded, customer left · ₹956 due cleared" for the panel. */
export function cancelNote(sub: Subscription): string {
  const c = sub as Subscription & CancelFields;
  return "Cancelled"
    + (c.cancelled_at ? ` on ${formatDate(c.cancelled_at)}` : "")
    + (c.cancel_reason ? ` — ${c.cancel_reason}` : "")
    + ((c.cancel_due_cleared ?? 0) > 0 ? ` · ${rupee(c.cancel_due_cleared ?? 0)} due cleared` : "");
}

export function CancelSubscriptionDialog({ sub, open, onOpenChange, clearDueDefault = false, defaultReason = "" }: {
  sub: Pick<Subscription, "id" | "customer_name" | "plan" | "outstanding_amount" | "start_date">;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** True when the payment was just refunded — the due is not real any more. */
  clearDueDefault?: boolean;
  defaultReason?: string;
}) {
  const cancel = useCancelSubscription();
  const due = sub.outstanding_amount ?? 0;
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
      { id: sub.id, lastDay, reason: reason.trim(), clearDue: due > 0 && clearDue },
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
          {due > 0 && (
            <label className="flex items-start gap-2 text-sm text-ink-2">
              <Checkbox checked={clearDue} onCheckedChange={(v) => setClearDue(v === true)} className="mt-0.5" />
              <span>
                Clear the {rupee(due)} still shown as due
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
          <Button variant="danger" onClick={onConfirm} disabled={!reasonOk || !dateOk} loading={cancel.isPending}>
            Cancel subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
