/**
 * R-2519 "Cancel quote" — an unpaid quote or proforma is cancelled, never deleted: the reason is
 * kept, it leaves the reminders and "awaiting payment", and the subscription is not touched (unlike
 * "Customer stopped"). Undo is on the same menu while nothing was paid.
 * One call: POST /api/quotes/:id/cancel (cancel_quote).
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function CancelQuoteDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string;
  partRequest: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const { open, onOpenChange, quoteId, partRequest, pending, onConfirm } = props;
  const [reason, setReason] = React.useState("");
  React.useEffect(() => { if (open) setReason(""); }, [open]);
  const ready = reason.trim().length >= 5;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="x" size={18} className="text-rose" />
            Cancel {quoteId}?
          </DialogTitle>
          <DialogDescription>
            It is kept on record as Cancelled — no reminders, nothing awaiting payment. The subscription is not changed.
            {partRequest ? " Its period can be billed again with Bill next part." : ""} You can undo this while nothing is paid.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label htmlFor="cancel-quote-reason" className="text-2xs font-medium text-ink-3">Why is it cancelled?</label>
          <textarea
            id="cancel-quote-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="For example: wrong seats — billing again at 18"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button type="button" variant="danger" icon="x" disabled={!ready} loading={pending}
            onClick={() => onConfirm(reason.trim())}>
            Cancel quote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
