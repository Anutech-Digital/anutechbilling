/**
 * R-2535 — the footer of "Reconcile from Zoho": the preview ("N clean pairs, M need a look"), one
 * confirm step before anything is booked, the lines the server would not book, and "Undo this run".
 * Booking itself: zoho-bulk-reconcile.tsx → bookOnServer (lib/integrations/zoho-books/bulk-book-run.ts).
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { RefusedRow, RunPreview } from "@/lib/integrations/zoho-books/bulk-book-run";

export type BookMode = "clean" | "selected";

interface Props {
  preview: RunPreview;
  selected: { count: number; total: number };
  progress: { at: number; of: number } | null;
  /** Booking or reading is going on, or the plan is not loaded. */
  disabled: boolean;
  booking: boolean;
  onBook: (mode: BookMode) => void;
  onDownload: (() => void) | null;
  runId: string | null;
  /** Lines this run booked that are still booked. */
  bookedInRun: number;
  undoing: boolean;
  onUndo: () => void;
}

export function ZohoBulkRunBar(p: Props) {
  const [confirm, setConfirm] = React.useState<BookMode | "undo" | null>(null);
  const count = confirm === "clean" ? p.preview.clean : p.selected.count;
  const total = confirm === "clean" ? p.preview.cleanTotal : p.selected.total;
  return (
    <div className="border-t border-hairline px-5 py-3 space-y-2">
      {confirm && confirm !== "undo" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber/40 bg-amber-soft/40 px-3 py-2 text-xs">
          <span className="text-ink">
            Book {count} {count === 1 ? "line" : "lines"} · {rupee(total)}? Each is booked the way the Reconcile sheet books it. Lines already reconciled or in a locked month are skipped and listed.
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="default" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => { const m = confirm; setConfirm(null); p.onBook(m); }}>Book {count}</Button>
          </span>
        </div>
      )}
      {confirm === "undo" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose/30 bg-rose-soft/40 px-3 py-2 text-xs">
          <span className="text-ink">
            Undo this run? The {p.bookedInRun} {p.bookedInRun === 1 ? "line goes" : "lines go"} back to unmatched; each new sale it made is reversed (receipt removed, invoice voided or credited). Lines booked another way, or changed since, are listed for you.
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="default" onClick={() => setConfirm(null)}>Keep</Button>
            <Button size="sm" variant="danger" onClick={() => { setConfirm(null); p.onUndo(); }}>Undo this run</Button>
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-ink-2" aria-live="polite">
          {p.booking && p.progress
            ? `Booking ${Math.min(p.progress.at, p.progress.of)} of ${p.progress.of}…`
            : `${p.preview.clean} clean ${p.preview.clean === 1 ? "pair" : "pairs"} (paired by UTR, nothing to check) · ${p.preview.needLook} need a look · ${p.selected.count} ticked`}
        </span>
        <span className="flex flex-wrap gap-2">
          {p.onDownload && <Button variant="default" icon="download" onClick={p.onDownload}>Download CSV</Button>}
          {p.runId && p.bookedInRun > 0 && (
            <Button variant="default" disabled={p.disabled || p.undoing} loading={p.undoing} onClick={() => setConfirm("undo")}>Undo this run</Button>
          )}
          <Button variant="default" disabled={p.disabled || p.selected.count === 0} onClick={() => setConfirm("selected")}>
            {`Book selected (${p.selected.count})`}
          </Button>
          <Button variant="primary" disabled={p.disabled || p.preview.clean === 0} loading={p.booking} onClick={() => setConfirm("clean")}>
            {`Book all clean (${p.preview.clean})`}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** The lines the server would not book in the last run, with why. */
export function ZohoRefusedList({ rows }: { rows: readonly RefusedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber/40 bg-amber-soft/30 px-3 py-2 text-xs">
      <p className="font-medium text-ink">{rows.length} {rows.length === 1 ? "line was" : "lines were"} not booked</p>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.txnId} className="text-ink-2">{formatDate(r.txnDate)} · {rupee(r.credit)} — {r.reason}</li>
        ))}
      </ul>
    </div>
  );
}
