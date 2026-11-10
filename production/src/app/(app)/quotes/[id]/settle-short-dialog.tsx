/**
 * R-2606 — confirm "Settle ₹X as round-off" on a quote billed in parts (R-2595's
 * settle_quote_part_short). Names the ledger and the bank line before anything is booked; the
 * amount and the line come from GET /api/quotes/:id/settle-short (read the way the RPC picks them),
 * and the POST books only that confirmed amount.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { SETTLE_SHORT_LEDGER, type SettleShortPreview } from "@/lib/quotes/settle-small-short";

export function SettleShortDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The short the money row shows — the title until the server's figure is in. */
  rowAmount: number;
  partIndex: number;
  partCount: number;
  /** undefined = still reading; null = nothing left to settle. */
  preview: Pick<SettleShortPreview, "amount" | "bankLine"> | null | undefined;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string | null, expected: number) => void;
}) {
  const { open, onOpenChange, rowAmount, partIndex, partCount, preview, pending, error, onConfirm } = props;
  const [note, setNote] = React.useState("");
  React.useEffect(() => { if (open) setNote(""); }, [open]);
  const amount = preview?.amount ?? rowAmount;
  const amt = rupee(amount);
  const line = preview?.bankLine ?? null;
  const ready = !!preview && !!line && !pending;

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
            {preview === undefined ? "Checking…"
              : line ? <>{rupee(line.credit)} credited on {formatDate(line.txnDate)}</>
              : <>The receipt is not matched to a bank line yet — match it on Banking → Reconcile first.</>}
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

        {(error || preview === null) && (
          <p role="alert" className="rounded-md border border-rose/50 bg-rose-soft/40 px-3 py-2 text-sm text-ink">
            {error ?? "Nothing is left to settle on this part — refresh the page."}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button type="button" variant="primary" icon="check_circle" disabled={!ready} loading={pending}
            onClick={() => { if (ready) onConfirm(note.trim() || null, amount); }}>
            Settle {amt}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
