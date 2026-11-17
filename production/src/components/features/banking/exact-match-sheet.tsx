/**
 * R-2677 (17 Nov 2026, G-RECON) — "Match all exact" on Banking → an account.
 *
 * Hand reconcile ran at ~16 lines an hour, yet many open lines already had an EXACT record in the
 * books (an imported expense, a receipt with the line's UTR, a payment already recorded on the Bills /
 * Expenses page). This sheet lists, for the page's own filter (dates, money in / out), every open line
 * the app's own matcher calls exact — the record and why — each row can be unticked; Match links the
 * ticked ones under one run id (the server re-checks every row and never creates a record); "Undo
 * this run" un-reconciles exactly that run. Owner / accountant only (the RPCs refuse anyone else).
 * Words: lib/banking/exact-match.ts.
 */
"use client";

import * as React from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { formatDate, rupee } from "@/lib/utils";
import {
  EXACT_KIND_LABEL, bookExactText, exactScope, exactSummary, reviewRows, rowsToBook, scopeText, undoExactText,
  type ExactRow, type ExactScope,
} from "@/lib/banking/exact-match";
import type { BankFilters } from "@/lib/banking/bank-filters";
import { useBookExactMatches, useExactCandidates, useLastExactRun, useUndoExactRun } from "@/lib/queries/bank-exact-match";

const TONE = {
  success: "border-emerald/30 bg-emerald-soft/40",
  warning: "border-amber/30 bg-amber-soft/40",
} as const;

const REVIEW_BADGE: Record<string, { kind: "warning" | "muted"; label: string }> = {
  ambiguous: { kind: "warning", label: "More than one match" },
  locked: { kind: "muted", label: "Locked books" },
  drawer: { kind: "muted", label: "Use the drawer" },
};

function ExactTable({ rows, unticked, onToggle }: {
  rows: ExactRow[];
  unticked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm table-fixed">
      <thead>
        <tr className="text-left text-3xs uppercase tracking-wider text-ink-3">
          <th className="px-3 py-2 w-[44px]"><span className="sr-only">Match</span></th>
          <th className="px-3 py-2">Bank line</th>
          <th className="px-3 py-2 w-[110px] text-right">Amount</th>
          <th className="px-3 py-2">Record in the books</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hairline">
        {rows.map((r) => (
          <tr key={r.txn_id} data-exact-row={r.txn_id} className="align-top">
            <td className="px-3 py-2">
              <Checkbox
                checked={!unticked.has(r.txn_id)}
                onCheckedChange={() => onToggle(r.txn_id)}
                aria-label={`Match the ${formatDate(r.txn_date)} line of ${rupee(r.amount)}`}
              />
            </td>
            <td className="px-3 py-2 min-w-0">
              <p className="text-xs text-ink-3 whitespace-nowrap">{formatDate(r.txn_date)} · {r.direction === "in" ? "Money in" : "Money out"}</p>
              <p className="text-sm text-ink-2 truncate" title={r.description ?? undefined}>{r.description || "—"}</p>
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums text-ink">{rupee(r.amount)}</td>
            <td className="px-3 py-2 min-w-0">
              <p className="text-sm text-ink truncate" title={r.match_label ?? undefined}>
                {r.kind ? EXACT_KIND_LABEL[r.kind] : "Record"}{r.match_label ? ` · ${r.match_label}` : ""}
              </p>
              <p className="text-xs text-ink-3">{r.why}</p>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReviewList({ rows }: { rows: ExactRow[] }) {
  return (
    <ul className="divide-y divide-hairline">
      {rows.map((r) => (
        <li key={r.txn_id} className="px-3 py-2 text-xs text-ink-3" data-exact-review={r.status}>
          <span className="text-ink-2">{formatDate(r.txn_date)} · {rupee(r.amount)} · {r.description || "—"}</span>{" "}
          <Badge kind={REVIEW_BADGE[r.status]?.kind ?? "muted"} size="sm">{REVIEW_BADGE[r.status]?.label ?? r.status}</Badge>{" "}
          {r.why}
        </li>
      ))}
    </ul>
  );
}

export function ExactMatchSheet({ accountId, scope, open, onOpenChange }: {
  accountId: string;
  scope: ExactScope;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const q = useExactCandidates(accountId, scope, open);
  const lastRun = useLastExactRun(accountId, open);
  const book = useBookExactMatches(accountId, scope);
  /* Undo un-reconciles a whole run — it asks once before it does (R-2677 review). */
  const [confirmUndo, setConfirmUndo] = React.useState(false);
  const undo = useUndoExactRun();
  const rows = React.useMemo(() => q.data ?? [], [q.data]);
  const sum = exactSummary(rows);
  const exact = React.useMemo(() => rows.filter((r) => r.status === "exact"), [rows]);
  const review = React.useMemo(() => reviewRows(rows), [rows]);
  const [unticked, setUnticked] = React.useState<ReadonlySet<string>>(new Set());
  const toBook = rowsToBook(rows, unticked);
  const [result, setResult] = React.useState<{ title: string; detail: string | null; tone: "success" | "warning" } | null>(null);
  React.useEffect(() => { if (!open) { setResult(null); setUnticked(new Set()); } }, [open]);

  const toggle = (id: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function onMatch() {
    try {
      const r = await book.mutateAsync(toBook);
      setResult(bookExactText(r));
      setUnticked(new Set());
    } catch { /* the hook toasts */ }
  }

  async function onUndo(runId: string) {
    setConfirmUndo(false);
    try {
      setResult(undoExactText(await undo.mutateAsync(runId)));
    } catch { /* the hook toasts */ }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[960px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Match all exact</SheetTitle>
          <SheetDescription>
            Open lines ({scopeText(scope, formatDate)}) that already have exactly one record in the books — a customer
            receipt, a paid expense or a payment already recorded on the Bills / Expenses page. Matching only links the
            line to that record: nothing new is booked. A line with two possible records, or a record two lines could be, is left for you.
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
                {confirmUndo
                  ? `Un-reconcile the ${lastRun.data.lines} ${lastRun.data.lines === 1 ? "line" : "lines"} this run matched? Lines changed by hand since are left as they are.`
                  : `Last run: ${lastRun.data.lines} ${lastRun.data.lines === 1 ? "line" : "lines"} matched on ${formatDate(lastRun.data.created_at)}`}
              </p>
              {confirmUndo ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="default" onClick={() => setConfirmUndo(false)}>Cancel</Button>
                  <Button size="sm" variant="primary" icon="refresh" loading={undo.isPending} onClick={() => onUndo(lastRun.data!.id)}>
                    {`Yes, un-reconcile ${lastRun.data.lines}`}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="default" icon="refresh" disabled={undo.isPending} onClick={() => setConfirmUndo(true)}>
                  Undo this run
                </Button>
              )}
            </div>
          )}

          {q.isLoading ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-3">Checking every open line against the books…</p>
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
            </div>
          ) : q.isError ? (
            <LoadError what="Exact matches" error={q.error} onRetry={() => q.refetch()} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-3">No open lines in this view.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-2" data-exact-summary>
                  {sum.checked} open {sum.checked === 1 ? "line" : "lines"} checked · {sum.exact} exact ({rupee(sum.exactAmount)})
                  {sum.ambiguous > 0 ? ` · ${sum.ambiguous} with more than one match` : ""}
                  {sum.drawer > 0 ? ` · ${sum.drawer} to do in the drawer` : ""}
                  {sum.locked > 0 ? ` · ${sum.locked} in locked books` : ""}
                  {sum.likely > 0 ? ` · ${sum.likely} only a close match` : ""}
                  {sum.none > 0 ? ` · ${sum.none} with no record yet` : ""}
                </p>
                <Button variant="primary" icon="check" disabled={toBook.length === 0 || q.isFetching} loading={book.isPending} onClick={onMatch}>
                  {`Match ${toBook.length} ${toBook.length === 1 ? "line" : "lines"}`}
                </Button>
              </div>
              {sum.cut && (
                <p className="text-xs text-amber" role="note">
                  Only the first {sum.checked.toLocaleString("en-IN")} open lines (oldest first) were checked — narrow the dates to see the rest.
                </p>
              )}

              {exact.length > 0 && (
                <section aria-label="Exact matches" className="rounded-md border border-hairline">
                  <ExactTable rows={exact} unticked={unticked} onToggle={toggle} />
                </section>
              )}

              {review.length > 0 && (
                <section aria-label="Not matched — look at these" className="rounded-md border border-hairline">
                  <p className="px-3 pt-3 text-xs font-semibold text-ink-2">Not matched — open these lines one by one</p>
                  <ReviewList rows={review} />
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The account page button + its sheet (the page's filter: dates and money in / out). */
export function ExactMatchButton({ accountId, filters }: { accountId: string; filters: Pick<BankFilters, "from" | "to" | "dir"> }) {
  const scope = exactScope(filters);
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        icon="check"
        onClick={() => setOpen(true)}
        title="Match every open line in this view that already has exactly one record in the books — you see the list first, and can undo the run"
      >
        Match all exact
      </Button>
      {/* Mounted only while open: no preview query until the owner asks. */}
      {open && <ExactMatchSheet accountId={accountId} scope={scope} open onOpenChange={setOpen} />}
    </>
  );
}
