"use client";

/**
 * R-1681 — pausing a subscription by hand asks WHY, and can tie the pause to the unpaid
 * invoice so paying it turns the service back on.
 *
 * Staging, 19 Oct (T-18): Payments → Subscription dues → Suspend → "Pause" wrote only
 * status = 'paused'. No reason was kept, and after the customer paid the ₹3,823 invoice the
 * subscription stayed paused — the auto-resume trigger only knew the automatic pause.
 *
 * Now every pause goes through suspend_subscription() (migration 20261019130206): the
 * reason is stored (and lands in the activity log), and with "unpaid invoice" ticked the
 * server links the oldest unpaid invoice of the subscription and sets resume_when_paid.
 * Paying that invoice resumes it exactly like the automatic pause and puts a bell notice
 * up: "turn the licences back on at Google / Microsoft too" (the app never touches them).
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { rupee } from "@/lib/utils";

export interface SuspendResult {
  subscription_id: string;
  status: "paused";
  reason: string;
  invoice_id: string | null;
  invoice_due: number | null;
  resume_when_paid: boolean;
}

export interface SuspendArgs {
  id: string;
  reason: string;
  /** Paused because an invoice is unpaid → the server links it; paying it resumes. */
  forUnpaid: boolean;
}

/** The server needs at least this many characters; the button waits for them. */
export const MIN_SUSPEND_REASON = 3;

/** What the success toast says — the operator must know whether it will come back by itself. */
export function suspendToast(r: SuspendResult): { title: string; description: string } {
  const vendor = "Suspend the licences in the Google / Microsoft admin as well — the app does not touch them.";
  if (r.resume_when_paid && r.invoice_id) {
    return {
      title: `Paused until ${r.invoice_id} is paid`,
      description: `When ${r.invoice_id}${r.invoice_due ? ` (${rupee(r.invoice_due)} due)` : ""} is paid it turns back on by itself and you get a bell notice. ${vendor}`,
    };
  }
  return { title: "Subscription paused", description: `Reason saved in the activity log. It stays paused until someone resumes it. ${vendor}` };
}

type SuspendRpc = (
  fn: "suspend_subscription",
  args: { p_subscription_id: string; p_reason: string; p_for_unpaid: boolean },
) => PromiseLike<{ data: SuspendResult | null; error: { message: string } | null }>;

export function useSuspendSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: SuspendArgs): Promise<SuspendResult> => {
      const supabase = createClient();
      /* suspend_subscription is newer than the generated types; same narrow cast as set_books_lock. */
      const rpc = supabase.rpc as unknown as SuspendRpc;
      const { data, error } = await rpc.call(supabase, "suspend_subscription", {
        p_subscription_id: args.id,
        p_reason:          args.reason.trim(),
        p_for_unpaid:      args.forUnpaid,
      });
      if (error) throw error;
      if (!data) throw new Error("The pause was not confirmed — refresh the page to see whether it was saved.");
      return data;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      const t = suspendToast(r);
      toast.success(t.title, { description: t.description });
    },
    onError: (e) => toastError(e, { fallback: "Could not pause — the subscription is still active. Try again." }),
  });
}

export function SuspendSubscriptionDialog({ sub, open, onOpenChange, forUnpaidDefault = true, onDone }: {
  sub: { id: string; customer_name: string; plan?: string | null; outstanding_amount?: number | null };
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** From Subscription dues the pause is almost always for the unpaid bill. */
  forUnpaidDefault?: boolean;
  onDone?: (r: SuspendResult) => void;
}) {
  const suspend = useSuspendSubscription();
  const [reason, setReason] = React.useState("");
  const [forUnpaid, setForUnpaid] = React.useState(forUnpaidDefault);
  React.useEffect(() => {
    if (!open) return;
    setReason("");
    setForUnpaid(forUnpaidDefault);
  }, [open, sub.id, forUnpaidDefault]);

  const reasonOk = reason.trim().length >= MIN_SUSPEND_REASON;
  const due = sub.outstanding_amount ?? 0;

  const onConfirm = () => {
    if (!reasonOk) return;
    suspend.mutate(
      { id: sub.id, reason, forUnpaid },
      { onSuccess: (r) => { onDone?.(r); onOpenChange(false); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="font-serif text-xl text-ink">Pause subscription</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {sub.customer_name}{sub.plan ? ` · ${sub.plan}` : ""}. Pausing stops it in the app only — suspend the
          licences in the Google / Microsoft admin separately.
        </DialogDescription>

        <div className="mt-4 space-y-3">
          <FormField label="Why are you pausing it?" htmlFor="suspend-sub-reason" required>
            <Textarea
              id="suspend-sub-reason"
              name="reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={due > 0 ? `${rupee(due)} unpaid for 30+ days` : "Customer asked to pause"}
            />
          </FormField>
          {!reasonOk && (
            <p className={reason.length > 0 ? "text-2xs text-rose" : "text-2xs text-ink-3"}>
              Write a few words to enable Pause — the reason is kept in the activity log.
            </p>
          )}
          <label className="flex items-start gap-2 text-sm text-ink-2">
            <Checkbox
              id="suspend-sub-for-unpaid"
              checked={forUnpaid}
              onCheckedChange={(v) => setForUnpaid(v === true)}
              className="mt-0.5"
            />
            <span>
              Paused because an invoice is unpaid
              <span className="block text-2xs text-ink-3">
                The oldest unpaid invoice is linked. When it is paid, the subscription turns back on by itself and you get a bell notice.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={suspend.isPending}>
            Keep it active
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!reasonOk} loading={suspend.isPending}>
            Pause
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
