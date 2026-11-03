/**
 * CloseBankAccountDialog — R-2384: "Close account" from the Banking account menu.
 *
 * Only at ₹0 (a broken FD, an old account emptied out). Asks the closed date (default today,
 * not before the account's last line — the server checks both) and an optional note. Closing
 * hides the account from the Banking list and from every picker for new money; its lines,
 * matches and report figures stay. "Reopen" on a closed account undoes it.
 * When the balance is not ₹0 the dialog says why and offers no Close button.
 * R-2389: when the server refuses (e.g. staging's 403 "permission denied for function
 * ist_today"), the reason shows INSIDE the dialog — a toast behind the open dialog went unseen.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { istToday } from "@/lib/dates/ist";
import { useCloseBankAccount, type BankAccountRow } from "@/lib/queries/bank";
import { closeAccountProblem } from "@/lib/banking/account-close";
import { describeError } from "@/lib/errors/toast-error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccountRow | null;
}

export function CloseBankAccountDialog({ open, onOpenChange, account }: Props) {
  const close = useCloseBankAccount();
  const [closedOn, setClosedOn] = React.useState(istToday());
  const [note, setNote] = React.useState("");
  const [refusal, setRefusal] = React.useState<{ reason: string; serverText?: string } | null>(null);

  React.useEffect(() => {
    if (open) { setClosedOn(istToday()); setNote(""); setRefusal(null); }
  }, [open, account?.id]);

  if (!account) return null;
  const problem = closeAccountProblem(account);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!account || problem || !closedOn) return;
    setRefusal(null);
    try {
      await close.mutateAsync({ id: account.id, closedOn, note });
      onOpenChange(false);
    } catch (err) {
      /* R-2389: the hook toasts too, but the dialog stays open over it — say it here as well,
         with the server's own words when the friendly text replaced them. */
      const d = describeError(err, "Could not close the account");
      setRefusal({ reason: d.message, serverText: d.translated && d.raw && d.raw !== d.message ? d.raw : undefined });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Close &ldquo;{account.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              A closed account leaves the Banking list and is not offered for new entries. Its
              transactions and reports stay as they are — you can see it under Closed accounts and reopen it any time.
            </DialogDescription>
          </DialogHeader>

          {problem ? (
            <div role="alert" className="my-3 flex items-start gap-2 rounded-md border border-amber/40 bg-amber-soft/50 px-3 py-2 text-sm text-amber-ink">
              <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
              <span>{problem}</span>
            </div>
          ) : (
            <div className="space-y-4 py-3">
              <FormField label="Closed on" required htmlFor="close-account-date">
                <Input
                  id="close-account-date"
                  type="date"
                  max={istToday()}
                  value={closedOn}
                  onChange={(e) => setClosedOn(e.target.value)}
                />
              </FormField>
              <FormField label="Note (optional)" htmlFor="close-account-note">
                <Textarea
                  id="close-account-note"
                  rows={2}
                  maxLength={300}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. FD broken on 10 Apr, money moved to HDFC Current"
                />
              </FormField>
              {refusal && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-rose/40 bg-rose-soft/40 px-3 py-2 text-sm text-rose-ink">
                  <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
                  <span>
                    Could not close: {refusal.reason}
                    {refusal.serverText && <span className="mt-0.5 block text-xs">Server said: {refusal.serverText}</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
              {problem ? "OK" : "Cancel"}
            </Button>
            {!problem && (
              <Button type="submit" variant="primary" loading={close.isPending} disabled={!closedOn}>
                Close account
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
