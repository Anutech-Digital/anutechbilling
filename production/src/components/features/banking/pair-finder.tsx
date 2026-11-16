/**
 * R-2656 (10 Nov 2026, G-RECON N3) — "Find transfer & reversal pairs" on Banking.
 *
 * FD / sweep / OD / credit-card transfers between the company's own accounts and same-account
 * reversals (REV / RET / UPIRET / I/W CHQ RET) were booked by hand one line at a time. This sheet
 * shows every pair the server finds (bank_pair_candidates) with the reason, books the sure ones in
 * one click (book_bank_pairs — the transfer goes through reconcile_bank_txn_as_transfer, the reversal
 * through the manual reversal pair) and keeps an Undo for the run (undo_bank_pair_run).
 * Owner / accountant only (the RPCs refuse anyone else). Words: lib/banking/transfer-pair.ts.
 */
"use client";

import * as React from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { formatDate, rupee } from "@/lib/utils";
import {
  PAIR_KIND_LABEL, PAIR_STATUS_LABEL, bookResultText, pairSummary, pairsToBook, undoResultText,
  type PairRow, type PairStatus,
} from "@/lib/banking/transfer-pair";
import { useBookPairs, useLastPairRun, usePairCandidates, useUndoPairRun } from "@/lib/queries/bank-pairs";

const STATUS_BADGE: Record<PairStatus, "success" | "warning" | "muted" | "danger"> = {
  sure: "success",
  check: "warning",
  ambiguous: "warning",
  other_side_booked: "danger",
  locked: "muted",
};

const TONE = {
  success: "border-emerald/30 bg-emerald-soft/40",
  warning: "border-amber/30 bg-amber-soft/40",
} as const;

function Side({ date, account, description }: { date: string; account: string; description: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-3 whitespace-nowrap">{formatDate(date)} · {account}</p>
      <p className="text-sm text-ink-2 truncate" title={description ?? undefined}>{description || "—"}</p>
    </div>
  );
}

function PairTable({ rows }: { rows: PairRow[] }) {
  return (
    <table className="w-full text-sm table-fixed">
      <thead>
        <tr className="text-left text-3xs uppercase tracking-wider text-ink-3">
          <th className="px-3 py-2 w-[170px]">Kind</th>
          <th className="px-3 py-2">Money out</th>
          <th className="px-3 py-2">Money in</th>
          <th className="px-3 py-2 w-[110px] text-right">Amount</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hairline">
        {rows.map((r) => (
          <tr key={`${r.out_txn_id}:${r.in_txn_id}`} data-pair-status={r.status} className="align-top">
            <td className="px-3 py-2">
              <p className="text-sm text-ink">{PAIR_KIND_LABEL[r.kind]}</p>
              <Badge kind={STATUS_BADGE[r.status]} size="sm">{PAIR_STATUS_LABEL[r.status]}</Badge>
            </td>
            <td className="px-3 py-2"><Side date={r.out_date} account={r.out_account} description={r.out_description} /></td>
            <td className="px-3 py-2">
              <Side date={r.in_date} account={r.in_account} description={r.in_description} />
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-ink">{rupee(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReasonList({ rows }: { rows: PairRow[] }) {
  return (
    <ul className="space-y-1 text-xs text-ink-3">
      {rows.map((r) => (
        <li key={`${r.out_txn_id}:${r.in_txn_id}:why`}>
          <span className="text-ink-2">{formatDate(r.out_date)} {rupee(r.amount)}:</span> {r.reason}
        </li>
      ))}
    </ul>
  );
}

export function PairFinderSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = usePairCandidates(open);
  const lastRun = useLastPairRun(open);
  const book = useBookPairs();
  const undo = useUndoPairRun();
  const rows = React.useMemo(() => q.data ?? [], [q.data]);
  const sum = pairSummary(rows);
  const sure = rows.filter((r) => r.status === "sure");
  const review = rows.filter((r) => r.status !== "sure");
  const toBook = pairsToBook(rows);
  const [result, setResult] = React.useState<{ title: string; detail: string | null; tone: "success" | "warning" } | null>(null);
  React.useEffect(() => { if (!open) setResult(null); }, [open]);

  async function onBook() {
    try {
      const r = await book.mutateAsync(toBook);
      setResult(bookResultText(r));
    } catch { /* the hook toasts */ }
  }

  async function onUndo(runId: string) {
    try {
      const r = await undo.mutateAsync(runId);
      setResult(undoResultText(r));
    } catch { /* the hook toasts */ }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[920px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Transfer &amp; reversal pairs</SheetTitle>
          <SheetDescription>
            Two open lines with the same amount, one out and one in, at most 3 days apart: money between your own
            accounts (FD, sweep, OD, card) or a payment that came back (REV, RET, cheque return). Only a pair with
            exactly one possible match is booked.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          {result && (
            <div role="status" className={`rounded-md border px-4 py-3 ${TONE[result.tone]}`}>
              <p className="text-sm font-semibold text-ink">{result.title}</p>
              {result.detail && <p className="mt-0.5 text-xs text-ink-2">{result.detail}</p>}
            </div>
          )}

          {lastRun.data && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-4 py-2">
              <p className="text-xs text-ink-2">
                Last run: {lastRun.data.pairs} {lastRun.data.pairs === 1 ? "pair" : "pairs"} booked on {formatDate(lastRun.data.created_at)}
              </p>
              <Button size="sm" variant="default" icon="refresh" loading={undo.isPending} onClick={() => onUndo(lastRun.data!.id)}>
                Undo this run
              </Button>
            </div>
          )}

          {q.isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
          ) : q.isError ? (
            <LoadError what="Transfer pairs" error={q.error} onRetry={() => q.refetch()} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-3">No transfer or reversal pairs among the open lines.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-2" data-pair-summary>
                  {sum.sure} ready to book ({rupee(sum.sureAmount)}) · {sum.ambiguous} with more than one match
                  {sum.check > 0 ? ` · ${sum.check} to check by hand` : ""}
                  {sum.otherSideBooked > 0 ? ` · ${sum.otherSideBooked} with the other side already booked` : ""}
                  {sum.locked > 0 ? ` · ${sum.locked} in locked books` : ""}
                </p>
                <Button variant="primary" icon="check" disabled={toBook.length === 0} loading={book.isPending} onClick={onBook}>
                  {`Book ${toBook.length} ${toBook.length === 1 ? "pair" : "pairs"}`}
                </Button>
              </div>

              {sure.length > 0 && (
                <section aria-label="Ready to book" className="rounded-md border border-hairline">
                  <PairTable rows={sure} />
                  <div className="border-t border-hairline px-3 py-2"><ReasonList rows={sure} /></div>
                </section>
              )}

              {review.length > 0 && (
                <section aria-label="Not booked — look at these" className="rounded-md border border-hairline">
                  <p className="px-3 pt-3 text-xs font-semibold text-ink-2">Not booked — pair these by hand on the line, or ask the owner</p>
                  <PairTable rows={review} />
                  <div className="border-t border-hairline px-3 py-2"><ReasonList rows={review} /></div>
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The Banking header button + its sheet. */
export function PairFinderButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button icon="link" onClick={() => setOpen(true)} title="Find own-account transfers and reversals among the open bank lines, and book the sure ones">
        Find transfer pairs
      </Button>
      {/* Mounted only while open: no pair query (or query client) until the owner asks. */}
      {open && <PairFinderSheet open onOpenChange={setOpen} />}
    </>
  );
}
