/**
 * "Mark rejected" — asks why, and offers to mark the lead Lost (R-482 / board R-452).
 *
 * Before, one click rejected the quote with no reason and the lead stayed in Quote Sent, its
 * value still counted in the pipeline. The reasons are the lead's loss reasons, so one code
 * set feeds "Why deals are lost". The Lost box is offered only when this was the lead's last
 * open quote (lib/quotes/quote-page-actions.ts → rejectLeadOffer).
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { LOSS_REASONS, type LossReasonCode } from "@/lib/leads/loss-reasons";
import type { RejectLeadOffer } from "@/lib/quotes/quote-page-actions";
import { cn } from "@/lib/utils";

export interface RejectQuoteInput {
  reason: LossReasonCode;
  note: string | null;
  markLeadLost: boolean;
}

export function RejectQuoteDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string;
  leadOffer: RejectLeadOffer;
  pending: boolean;
  onConfirm: (input: RejectQuoteInput) => void;
}) {
  const { open, onOpenChange, quoteId, leadOffer, pending, onConfirm } = props;
  const [reason, setReason] = React.useState<LossReasonCode | null>(null);
  const [note, setNote] = React.useState("");
  const [markLost, setMarkLost] = React.useState(true);

  React.useEffect(() => {
    if (open) { setReason(null); setNote(""); setMarkLost(true); }
  }, [open]);

  const noteNeeded = reason === "other" && !note.trim();
  const ready = reason !== null && !noteNeeded;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="x" size={18} className="text-rose" />
            Mark {quoteId} rejected?
          </DialogTitle>
          <DialogDescription>Why did the customer say no?</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Reason">
          {LOSS_REASONS.map((r) => (
            <button
              key={r.code}
              type="button"
              role="radio"
              aria-checked={reason === r.code}
              onClick={() => setReason(r.code)}
              className={cn(
                "text-left rounded-lg border p-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                reason === r.code ? "border-amber bg-amber-soft/60" : "border-hairline hover:border-amber/50 hover:bg-paper-2",
              )}
            >
              <div className="text-sm font-semibold text-ink">{r.label}</div>
              <div className="text-2xs text-ink-3 leading-snug mt-0.5">{r.hint}</div>
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="reject-note" className="text-2xs font-medium text-ink-3">
            Note {reason === "other" ? <span className="text-rose">(needed for “Other”)</span> : "(optional)"}
          </label>
          <textarea
            id="reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber"
          />
        </div>

        {leadOffer.offer ? (
          <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={markLost}
              onChange={(e) => setMarkLost(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber"
            />
            <span>
              Also mark the lead Lost
              <span className="block text-2xs text-ink-3">This was its only open quote. The reason above is saved on the lead.</span>
            </span>
          </label>
        ) : leadOffer.note ? (
          <p className="text-2xs text-ink-3">{leadOffer.note}</p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            variant="danger"
            icon="x"
            disabled={!ready}
            loading={pending}
            onClick={() => reason && onConfirm({ reason, note: note.trim() || null, markLeadLost: leadOffer.offer && markLost })}
          >
            Mark rejected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
