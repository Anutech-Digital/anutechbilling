/**
 * R-2606 — confirm "Settle ₹X as round-off" on a quote billed in parts (R-2595's
 * settle_quote_part_short). Names the ledger and the bank line before anything is booked.
 * One call: POST /api/quotes/:id/settle-short.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SETTLE_SHORT_LEDGER } from "@/lib/quotes/settle-small-short";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function SettleShortDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amount: number;
  partIndex: number;
  partCount: number;
  /** The last receipt — the RPC settles on the bank line that brought it. */
  bankLine: { amount: number; on: string } | null;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string | null) => void;
}) {
  const { open, onOpenChange, amount, partIndex, partCount, bankLine, pending, error, onConfirm } = props;
  const [note, setNote] = React.useState("");
  React.useEffect(() => { if (open) setNote(""); }, [open]);
  const amt = inr(amount);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="check_circle" size={18} className="text-ink-2" />
            Settle {amt} as round-off?
          </DialogTitle>
          <DialogDescription>
            Part {partIndex} of {partCount} came in {amt} short. It is booked as a small difference (round-off) — no money is asked from the customer.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-3">Ledger</dt>
          <dd className="text-ink">{SETTLE_SHORT_LEDGER}</dd>
          <dt className="text-ink-3">Bank line</dt>
          <dd className="text-ink">
            {bankLine ? <>{inr(bankLine.amount)} received on {bankLine.on}</> : <>The bank line of the last receipt</>}
          </dd>
          <dt className="text-ink-3">After this</dt>
          <dd className="text-ink">Part {partIndex} shows fully received. The next part&apos;s bill and payment request do not change.</dd>
        </dl>

        <div>
          <label htmlFor="settle-short-note" className="text-2xs font-medium text-ink-3">Note (optional)</label>
          <input
            id="settle-short-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="For example: NEFT came short"
            className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-rose/50 bg-rose-soft/40 px-3 py-2 text-sm text-ink">{error}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button type="button" variant="primary" icon="check_circle" disabled={pending} loading={pending}
            onClick={() => { if (!pending) onConfirm(note.trim() || null); }}>
            Settle {amt}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
