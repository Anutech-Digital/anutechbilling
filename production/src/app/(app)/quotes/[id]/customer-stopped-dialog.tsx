/**
 * R-2044 "Customer stopped" — on an UNPAID payment request for one part of a subscription billed
 * in parts. The customer broke the commitment: the request is closed and the subscription is
 * cancelled (default) or paused. Nothing was invoiced for the part, so nothing is left in GST or
 * receivables. One call: POST /api/quotes/:id/customer-stopped (stop_part_payment_request).
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CustomerStoppedEnd } from "@/lib/billing/part-requests";

const ENDS: { value: CustomerStoppedEnd; label: string; hint: string }[] = [
  { value: "cancel", label: "Cancel the subscription", hint: "It ends today and leaves MRR and renewals." },
  { value: "pause",  label: "Pause the subscription",  hint: "It stays on record; turn it back on later from Subscriptions." },
];

export function CustomerStoppedDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string;
  pending: boolean;
  onConfirm: (input: { end: CustomerStoppedEnd; reason: string }) => void;
}) {
  const { open, onOpenChange, quoteId, pending, onConfirm } = props;
  const [end, setEnd] = React.useState<CustomerStoppedEnd>("cancel");
  const [reason, setReason] = React.useState("");
  React.useEffect(() => { if (open) { setEnd("cancel"); setReason(""); } }, [open]);
  const ready = reason.trim().length >= 5;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="x" size={18} className="text-rose" />
            Customer stopped paying?
          </DialogTitle>
          <DialogDescription>
            {quoteId} is closed and no tax invoice is raised for this part — nothing is owed in GST or receivables.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="What happens to the subscription">
          {ENDS.map((e) => (
            <button
              key={e.value}
              type="button"
              role="radio"
              aria-checked={end === e.value}
              onClick={() => setEnd(e.value)}
              className={cn(
                "text-left rounded-lg border p-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                end === e.value ? "border-amber bg-amber-soft/60" : "border-hairline hover:border-amber/50 hover:bg-paper-2",
              )}
            >
              <div className="text-sm font-semibold text-ink">{e.label}</div>
              <div className="text-2xs text-ink-3 leading-snug mt-0.5">{e.hint}</div>
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="stopped-reason" className="text-2xs font-medium text-ink-3">Why did the customer stop?</label>
          <textarea
            id="stopped-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="For example: moved to another provider"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            variant="danger"
            icon="x"
            disabled={!ready}
            loading={pending}
            onClick={() => onConfirm({ end, reason: reason.trim() })}
          >
            Customer stopped
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
