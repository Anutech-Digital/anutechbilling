"use client";

/**
 * R-2225 (Zoho Billing audit A1): "Won't renew" — the customer said they will not renew.
 *
 * The subscription keeps running to its renewal date and then ends (the renewals cron lapses it to
 * Expired, RN-24). No renewal quote and no reminder go out; it leaves the Renewals urgency lists
 * and is counted At risk. Parts of the current term still bill as usual. Undo is in the drawer.
 */
import * as React from "react";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { nonRenewingInputError } from "@/lib/subscriptions/non-renewing";
import { useSetNonRenewing } from "./use-non-renewing";
import { LeaveReasonField } from "./leave-reason-field";
import { isLeaveReason, leaveReasonInputError, leaveReasonText } from "@/lib/subscriptions/leave-reasons";

export function NonRenewingDialog({ sub, open, onOpenChange }: {
  sub: { id: string; customer_name: string; plan: string; renewal_date: string | null };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const setNr = useSetNonRenewing();
  const today = istToday();
  const [reasonCode, setReasonCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [saidOn, setSaidOn] = React.useState(today);
  React.useEffect(() => {
    if (!open) return;
    setReasonCode("");
    setNote("");
    setSaidOn(istToday());
  }, [open, sub.id]);

  /* R-2243: the reason is the shared picklist (+ note); the date rule is nonRenewingInputError's. */
  const code = isLeaveReason(reasonCode) ? reasonCode : null;
  const reasonProblem = leaveReasonInputError({ code: reasonCode, note });
  const dateRule = nonRenewingInputError({ reason: "x".repeat(5), saidOn, today });
  const problem = reasonProblem ?? dateRule;
  /* Shown only for the date — the reason's rule is in its labels, the button stays off until it is met. */
  const dateProblem = saidOn > today ? dateRule : null;

  const onConfirm = () => {
    if (problem || !code) return;
    setNr.mutate({ id: sub.id, on: true, reason: leaveReasonText(code, note), reasonCode: code, saidOn }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="font-serif text-xl text-ink">Won&apos;t renew</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {sub.customer_name} · {sub.plan}. It runs till {formatDate(sub.renewal_date)}, then ends.
          No renewal quote or reminder goes out. Parts of this term still due are billed as usual.
        </DialogDescription>

        <div className="mt-4 space-y-3">
          <LeaveReasonField idPrefix="nonrenew-reason" code={reasonCode} note={note} onCode={setReasonCode} onNote={setNote} />
          <FormField label="Date the customer told you" htmlFor="nonrenew-said-on" required>
            <Input id="nonrenew-said-on" name="said_on" type="date" value={saidOn} max={today}
              onChange={(e) => setSaidOn(e.target.value)} />
          </FormField>
          {dateProblem && <p className="text-2xs text-rose">{dateProblem}</p>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={setNr.isPending}>Keep renewing</Button>
          <Button variant="primary" onClick={onConfirm} disabled={!!problem} loading={setNr.isPending}>
            Mark Won&apos;t renew
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
