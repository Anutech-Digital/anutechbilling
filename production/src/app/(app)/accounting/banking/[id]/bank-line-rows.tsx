/**
 * R-2685 — the bank page's line row (desktop table) and card (phone / tablet), moved out of page.tsx
 * (max-lines). Both are memoised: the page hands them stable (line) => … handlers, so a page render
 * (each list landing, each filter) draws only the rows whose own data changed.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { BankTransactionRow } from "@/lib/queries/bank";
import type { InvoiceMatch } from "@/lib/banking/invoice-credit-match";
import type { SplitLinePayment } from "@/lib/banking/bank-row-label";
import { BookingParty, LineNotes, MatchedBadge, TxnStatusBadge } from "@/components/features/banking/bank-line-status";
import { InvoiceMatchChip } from "@/components/features/banking/invoice-match-chip";
import { RemittanceText } from "@/components/features/banking/remittance-text";
import { rupee, formatDate } from "@/lib/utils";
import type { RunningBalance } from "@/lib/banking/running-balance";
import { RunningBalanceText } from "./running-balance-text";
import type { LineNoteLines } from "@/lib/banking/manual-reconcile";
import type { LineBooking } from "@/lib/banking/line-booking";

// ============================================================
// Shared bits (used by both the desktop row and the mobile card)
// ============================================================
function TxnAmount({ txn }: { txn: BankTransactionRow }) {
  if (txn.debit > 0)  return <span className="text-rose">-{rupee(txn.debit)}</span>;
  if (txn.credit > 0) return <span className="text-emerald">+{rupee(txn.credit)}</span>;
  return <span className="text-ink-3">—</span>;
}

// ============================================================
// Row (desktop)
// ============================================================
/** R-1895: the line a deep link (?txn=) pointed at — lit up for a few seconds. */
const HIGHLIGHT = "bg-amber-soft ring-2 ring-inset ring-amber-400 transition-colors duration-700";

export const TransactionRow = React.memo(function TransactionRow({
  txn,
  highlighted = false,
  invoiceMatch,
  onReconcile: onReconcileTxn,
  onUnreconcile: onUnreconcileTxn,
  onRelink: onRelinkTxn,
  isAdvance = false,
  splitPays,
  notes = null,
  running,
  booking,
}: {
  txn: BankTransactionRow;
  /** R-2400: the balance after this line, from ALL the account's lines. */
  running?: RunningBalance;
  highlighted?: boolean;
  /** R-2361: manual reason / owner note + reversal pair, shown under the badge. */
  notes?: LineNoteLines | null;
  /** R-2378: the real booking of a 'manual' line — the badge + the party link. */
  booking?: LineBooking;
  /** R-2025 (0): booked as the customer's advance — the badge reads "Advance". */
  isAdvance?: boolean;
  /** R-2098: the receipts of a line that paid several items. */
  splitPays?: readonly SplitLinePayment[];
  /** R-399: a certain open-invoice match for this unmatched credit — the chip opens the drawer. */
  invoiceMatch?: InvoiceMatch;
  /** Both left out for a read-only viewer (R-254) — the status shows, the buttons do not. */
  onReconcile?: (t: BankTransactionRow) => void;
  onUnreconcile?: (t: BankTransactionRow) => void;
  /** R-1863: an old one-off bank sale — move it onto what it really paid. */
  onRelink?: (t: BankTransactionRow) => void;
}) {
  /* R-2685: the page passes stable (line) => … handlers, so this memoised row is drawn again only when its own data changes. */
  const onReconcile = onReconcileTxn ? () => onReconcileTxn(txn) : undefined;
  const onUnreconcile = onUnreconcileTxn ? () => onUnreconcileTxn(txn) : undefined;
  const onRelink = onRelinkTxn ? () => onRelinkTxn(txn) : undefined;
  /* R-2524: no mutation hook per row — each row's own useReconcileTransaction never ran, so its isPending was always false. */

  return (
    <tr data-txn-id={txn.id} aria-current={highlighted ? "true" : undefined}
      className={`border-b border-hairline last:border-b-0 transition-colors duration-700 ${highlighted ? HIGHLIGHT : "hover:bg-paper-2/30"}`}>
      <td className="px-4 py-3 text-ink-2 whitespace-nowrap truncate">
        {formatDate(txn.txn_date)}
      </td>
      <td className="px-4 py-3 align-top">
        {/* Wrap (not truncate) so the full narration is readable at the default
            width — no need to widen the column and push other columns off. */}
        <div className="font-medium text-ink break-words leading-snug">{txn.description}<RemittanceText description={txn.description} /></div>
        {txn.reference && (
          <div className="text-xs text-ink-3 font-mono mt-0.5 break-all">{txn.reference}</div>
        )}
        {invoiceMatch && onReconcile && (
          <div className="mt-1"><InvoiceMatchChip match={invoiceMatch} onOpen={onReconcile} /></div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-rose">
        {txn.debit > 0 ? rupee(txn.debit) : <span className="text-ink-3">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium text-emerald">
        {txn.credit > 0 ? rupee(txn.credit) : <span className="text-ink-3">—</span>}
      </td>
      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap font-medium">
        <RunningBalanceText running={running} />
      </td>
      <td className="px-4 py-3 text-right">
        {txn.matched_to_type === "transfer" ? (
          // Inter-account transfers are auto-reconciled self-balancing pairs —
          // un-reconciling one leg would orphan it, so no action here.
          <div className="flex flex-col items-end gap-0.5">
            <Badge kind="success" size="sm" dot>Inter-account</Badge>
            <span className="text-xs text-ink-3">Auto</span>
          </div>
        ) : txn.matched_to_type ? (
          // Reconciled: show WHAT it matched (this replaces the Status column)
          // plus a quiet way to undo it.
          <div className="flex flex-col items-end gap-0.5">
            <MatchedBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
            <BookingParty booking={booking} align="right" />
            <LineNotes notes={notes} align="right" />
            {onRelink && (
              <Button size="sm" variant="default" onClick={onRelink} title="Move this one-off sale onto the renewal, extra seats or quote it paid">
                Relink
              </Button>
            )}
            {onUnreconcile && (
              <button
                type="button"
                onClick={onUnreconcile}
                className="text-xs text-ink-3 hover:text-rose"
              >
                Un-reconcile
              </button>
            )}
          </div>
        ) : onReconcile ? (
          // Unmatched: the button alone conveys the status.
          <Button size="sm" variant="default" onClick={onReconcile}>
            Reconcile
          </Button>
        ) : (
          <TxnStatusBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
        )}
      </td>
    </tr>
  );
});

// ============================================================
// Card (mobile)
// ============================================================
export const TransactionCard = React.memo(function TransactionCard({ txn, running, highlighted = false, invoiceMatch, onReconcile: onReconcileTxn, onUnreconcile: onUnreconcileTxn, onRelink: onRelinkTxn, isAdvance = false, splitPays, notes = null, booking }: {
  txn: BankTransactionRow; running?: RunningBalance; highlighted?: boolean; invoiceMatch?: InvoiceMatch; onReconcile?: (t: BankTransactionRow) => void; onUnreconcile?: (t: BankTransactionRow) => void; onRelink?: (t: BankTransactionRow) => void; isAdvance?: boolean;
  splitPays?: readonly SplitLinePayment[];
  notes?: LineNoteLines | null;
  booking?: LineBooking;
}) {
  const onReconcile = onReconcileTxn ? () => onReconcileTxn(txn) : undefined;
  const onUnreconcile = onUnreconcileTxn ? () => onUnreconcileTxn(txn) : undefined;
  const onRelink = onRelinkTxn ? () => onRelinkTxn(txn) : undefined;
  return (
    <li data-txn-id={txn.id} aria-current={highlighted ? "true" : undefined}>
      <Card className={`p-3 transition-colors duration-700 ${highlighted ? HIGHLIGHT : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug text-ink break-words">{txn.description}<RemittanceText description={txn.description} /></div>
            <div className="mt-0.5 text-xs text-ink-3">
              {formatDate(txn.txn_date)}
              {txn.reference ? <span className="font-mono"> · {txn.reference}</span> : ""}
            </div>
            {invoiceMatch && onReconcile && (
              <div className="mt-1"><InvoiceMatchChip match={invoiceMatch} onOpen={onReconcile} /></div>
            )}
            <BookingParty booking={booking} />
            <LineNotes notes={notes} align="left" />
          </div>
          <div className="shrink-0 text-right font-serif text-base tabular-nums">
            <TxnAmount txn={txn} />
            {running && (
              <div className="mt-0.5 font-sans text-xs text-ink-3">
                Balance <RunningBalanceText running={running} />
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <TxnStatusBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
          {txn.matched_to_type === "transfer" ? (
            <span className="text-xs text-ink-3">Auto</span>
          ) : txn.matched_to_type ? (
            <div className="flex items-center gap-3">
              {onRelink && <Button size="sm" variant="default" onClick={onRelink}>Relink</Button>}
              {onUnreconcile ? (
                <button
                  type="button"
                  onClick={onUnreconcile}
                  className="text-xs text-ink-3 hover:text-rose"
                >
                  Un-reconcile
                </button>
              ) : null}
            </div>
          ) : onReconcile ? (
            <Button size="sm" variant="default" onClick={onReconcile}>
              Reconcile
            </Button>
          ) : null}
        </div>
      </Card>
    </li>
  );
});
