/**
 * R-2655 (11 Nov 2026, G-RECON N6) — "Match Zoho expenses" on Banking (part 1: the preview).
 *
 * After the Zoho FY purchase import, the expenses Zoho paid from a bank / card account are in the
 * books as paid but not tied to their statement line. Booking that debit as a NEW expense would put
 * the cost (and its input GST) in the books twice. This sheet shows, for every such Zoho document,
 * the one open debit that is it ("clean match") or why there is none ("need a look") — the server
 * decides (zoho_expense_bank_matches). Nothing is booked from here yet: a row opens its bank line,
 * where the expense is matched by hand. Owner / accountant only (the RPC refuses anyone else).
 * Words: lib/banking/zoho-expense-match.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { formatDate, rupee } from "@/lib/utils";
import {
  ZOHO_MATCH_STATUS_LABEL, zohoMatchBreakdown, zohoMatchDocLabel, zohoMatchHeadline, zohoMatchLineHref, zohoMatchSummary,
  type ZohoMatchRow, type ZohoMatchStatus,
} from "@/lib/banking/zoho-expense-match";
import { useZohoExpenseMatches } from "@/lib/queries/zoho-expense-match";

const STATUS_BADGE: Record<ZohoMatchStatus, "success" | "warning" | "muted" | "danger"> = {
  sure: "success",
  ambiguous: "warning",
  look: "warning",
  booked_elsewhere: "danger",
  locked: "muted",
  no_line: "muted",
};

function MatchTable({ rows }: { rows: ZohoMatchRow[] }) {
  return (
    <table className="w-full text-sm table-fixed">
      <thead>
        <tr className="text-left text-3xs uppercase tracking-wider text-ink-3">
          <th className="px-3 py-2">Zoho expense</th>
          <th className="px-3 py-2">Bank line</th>
          <th className="px-3 py-2 w-[110px] text-right">Amount</th>
          <th className="px-3 py-2 w-[100px]"><span className="sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hairline">
        {rows.map((r) => {
          const href = zohoMatchLineHref(r);
          const label = zohoMatchDocLabel(r);
          return (
            <tr key={`${r.zoho_doc_id}:${r.txn_id ?? "none"}`} data-match-status={r.status} className="align-top">
              <td className="px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-ink truncate" title={label}>{label}</p>
                  <p className="text-xs text-ink-3 truncate" title={r.categories ?? undefined}>
                    Paid {formatDate(r.paid_on)} · {r.account}{r.parts > 1 ? ` · ${r.parts} parts` : ""}
                  </p>
                  <Badge kind={STATUS_BADGE[r.status]} size="sm">{ZOHO_MATCH_STATUS_LABEL[r.status]}</Badge>
                </div>
              </td>
              <td className="px-3 py-2">
                {r.txn_id && r.txn_date ? (
                  <div className="min-w-0">
                    <p className="text-xs text-ink-3 whitespace-nowrap">{formatDate(r.txn_date)}</p>
                    <p className="text-sm text-ink-2 truncate" title={r.txn_description ?? undefined}>{r.txn_description || "—"}</p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-3">—</p>
                )}
                <p className="mt-1 text-xs text-ink-3">{r.reason}</p>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-ink">{rupee(r.cash)}</td>
              <td className="px-3 py-2 text-right">
                {href && (
                  <Link href={href} className="text-sm font-medium text-accent hover:underline whitespace-nowrap"
                        aria-label={`Open the bank line for ${label}`}>
                    Open line
                  </Link>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ZohoExpenseMatchSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useZohoExpenseMatches(open);
  const rows = React.useMemo(() => q.data ?? [], [q.data]);
  const sum = zohoMatchSummary(rows);
  const sure = rows.filter((r) => r.status === "sure");
  const review = rows.filter((r) => r.status !== "sure");
  const breakdown = zohoMatchBreakdown(sum);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[920px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Match Zoho expenses to bank lines</SheetTitle>
          <SheetDescription>
            Expenses imported from Zoho that were paid from a bank or card account, against the open money-out
            lines of that account: same amount (after TDS), within 7 days of the paid date. A clean match has
            exactly one line. Match it on the line — do not book the line as a new expense, or the cost is in the
            books twice.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          {q.isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
          ) : q.isError ? (
            <LoadError what="Zoho expense matches" error={q.error} onRetry={() => q.refetch()} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-3">
              No imported Zoho expense is waiting for its bank line. (Only expenses Zoho paid from a bank or card
              account are listed; unpaid bills are paid from Reconcile on the line.)
            </p>
          ) : (
            <>
              <div>
                <p className="text-sm font-semibold text-ink" data-match-summary>
                  {zohoMatchHeadline(sum)}{sum.sure > 0 ? ` (${rupee(sum.sureAmount)} clean)` : ""}
                </p>
                {breakdown && <p className="mt-0.5 text-xs text-ink-3">{breakdown}</p>}
              </div>

              {sure.length > 0 && (
                <section aria-label="Clean matches" className="rounded-md border border-hairline">
                  <p className="px-3 pt-3 text-xs font-semibold text-ink-2">Clean matches — open the line and match it to this expense</p>
                  <MatchTable rows={sure} />
                </section>
              )}

              {review.length > 0 && (
                <section aria-label="Need a look" className="rounded-md border border-hairline">
                  <p className="px-3 pt-3 text-xs font-semibold text-ink-2">Need a look — the reason is under each one</p>
                  <MatchTable rows={review} />
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
export function ZohoExpenseMatchButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button icon="link" onClick={() => setOpen(true)} title="See which open bank lines are expenses already imported from Zoho, so they are matched and not booked again">
        Match Zoho expenses
      </Button>
      {/* Mounted only while open: no query until the owner asks. */}
      {open && <ZohoExpenseMatchSheet open onOpenChange={setOpen} />}
    </>
  );
}
