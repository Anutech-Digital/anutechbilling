/**
 * The status column of a bank line on Banking → account page (/accounting/banking/[id]): the badge, the
 * booked party (R-2378) and the manual reason / reversal pair (R-2361). Moved out of the page (max-lines).
 */
"use client";

import Link from "next/link";
import type { Route } from "next";

import { Badge } from "@/components/ui/badge";
import { bankRowStatusLabel, splitPaymentsTitle, type SplitLinePayment } from "@/lib/banking/bank-row-label";
import type { LineBooking } from "@/lib/banking/line-booking";
import type { LineNoteLines } from "@/lib/banking/manual-reconcile";
import type { BankTransactionRow } from "@/lib/queries/bank";

/** R-2361: the reversal pair + the reason / owner note under a reconciled line's badge (full text on hover). */
export function LineNotes({ notes, align }: { notes: LineNoteLines | null; align: "left" | "right" }) {
  if (!notes) return null;
  return (
    <div className={`mt-0.5 min-w-0 max-w-full text-xs leading-snug text-ink-3 ${align === "right" ? "w-full text-right" : ""}`} data-testid="line-notes">
      {notes.reversal && <div className="text-ink-2">{notes.reversal}</div>}
      {notes.note && <div className="line-clamp-2 break-words" title={notes.note}>{notes.note}</div>}
    </div>
  );
}

/** R-2378: the party of a booked 'manual' line, linking to the page that holds its booking. */
export function BookingParty({ booking, align = "left" }: { booking?: LineBooking; align?: "left" | "right" }) {
  if (!booking) return null;
  return (
    <Link href={booking.href as Route} data-testid="line-booking" title={`Open ${booking.hrefLabel}`}
      className={`mt-0.5 block max-w-full truncate text-xs text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink ${align === "right" ? "text-right" : ""}`}>
      {booking.party ?? booking.hrefLabel}
    </Link>
  );
}

/** R-2098: "Payment" / "Advance" — or "N payments" with each receipt in the tooltip. */
export function MatchedBadge({ txn, isAdvance, splitPays, booking }: { txn: BankTransactionRow; isAdvance: boolean; splitPays?: readonly SplitLinePayment[]; booking?: LineBooking }) {
  const n = splitPays?.length ?? 0;
  /* R-2378: a booked 'manual' line names its booking ("Loan received"), never the bare "Reconciled". */
  const badge = <Badge kind="success" size="sm" dot>{booking ? booking.label : bankRowStatusLabel(txn.matched_to_type, isAdvance, n)}</Badge>;
  return n > 1 && splitPays ? <span title={splitPaymentsTitle(splitPays)}>{badge}</span> : badge;
}

/* R-2025 (0): an R-1863 advance reads "Advance", not "Payment" (lib/banking/bank-row-label). */
export function TxnStatusBadge({ txn, isAdvance = false, splitPays, booking }: { txn: BankTransactionRow; isAdvance?: boolean; splitPays?: readonly SplitLinePayment[]; booking?: LineBooking }) {
  return txn.matched_to_type
    ? <MatchedBadge txn={txn} isAdvance={isAdvance} splitPays={splitPays} booking={booking} />
    : <Badge kind="warning" size="sm" dot>Unmatched</Badge>;
}
