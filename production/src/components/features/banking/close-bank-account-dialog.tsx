/**
 * CloseBankAccountDialog — R-2384: "Close account" from the Banking account menu.
 *
 * Only at ₹0 (a broken FD, an old account emptied out). Asks the closed date (default today,
 * not before the account's last line — the server checks both) and an optional note. Closing
 * hides the account from the Banking list and from every picker for new money; its lines,
 * matches and report figures stay. "Reopen" on a closed account undoes it.
 * When the balance is not ₹0 the dialog says why and offers no Close button.
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccountRow | null;
}

export function CloseBankAccountDialog({ open, onOpenChange, account }: Props) {
  const close = useCloseBankAccount();
  const [closedOn, setClosedOn] = React.useState(istToday());
  const [note, setNote] = React.useState("");

  React.useEffect(() => { if (open) { setClosedOn(istToday()); setNote(""); } }, [open, account?.id]);

  if (!account) return null;
  const problem = closeAccountProblem(account);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!account || problem || !closedOn) return;
    try {
      await close.mutateAsync({ id: account.id, closedOn, note });
      onOpenChange(false);
    } catch { /* hook toasts the server's reason */ }
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
