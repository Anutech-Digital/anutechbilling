/**
 * R-2377 — Business Loans → "Add loan" → which bank line is the loan money.
 *
 * OD audit 2 Nov: Add loan always added a new money-in line, so a lender credit already in the
 * imported statement (₹40,00,000 from Bajaj Finance on 6 Jun) was counted twice. Now the dialog
 * lists the unmatched money-in lines on "Received into" for the loan amount (±₹1) within 15 days
 * of "Taken on" (lines naming the lender first — lib/banking/loan-disbursal-lines.ts, R-2341's
 * rule) and picks the first one; Save links the loan to THAT line. A new money-in line is made
 * only when the owner says the credit is not in the imported statement (warned), or when there
 * is no such line. Same look as R-2341's "Set up this loan".
 */
"use client";

import * as React from "react";

import { formatDate, rupee } from "@/lib/utils";
import { useLoanDisbursalLines } from "@/lib/banking/loan-setup-query";
import { businessLoanCandidates, takenOnWindow, type MoneyInLine } from "@/lib/banking/loan-disbursal-lines";

/** The pick: undefined = the first candidate, "none" = not in the statement, else a line id. */
export const NOT_IN_STATEMENT = "none";
export type LinePick = string | undefined;

export function useLoanMoneyLine(
  accountId: string, principal: number, takenOn: string, lender: string, pick: LinePick,
) {
  const window = accountId ? takenOnWindow(takenOn) : null;
  const linesQ = useLoanDisbursalLines(accountId || null, principal, window);
  const candidates = accountId ? businessLoanCandidates(linesQ.data ?? [], principal, takenOn, lender) : [];
  const chosen: MoneyInLine | null = pick === NOT_IN_STATEMENT
    ? null
    : candidates.find((c) => c.id === pick) ?? candidates[0] ?? null;
  /* While the lines load, Save must wait — otherwise it would add a new line next to the imported one. */
  const loading = Boolean(accountId && principal > 0 && window) && linesQ.isLoading;
  return { window, candidates, chosen, loading };
}

const labelCls = "block text-xs font-medium text-ink-2 mb-1";

export function LoanMoneyLinePicker({ principal, window, candidates, chosen, loading, onPick }: {
  principal: number;
  window: { from: string; to: string } | null;
  candidates: readonly MoneyInLine[];
  chosen: MoneyInLine | null;
  loading: boolean;
  onPick: (pick: LinePick) => void;
}) {
  if (!(principal > 0)) {
    return <p className="text-xs text-ink-3">Enter the loan amount to find the loan money in your imported statement.</p>;
  }
  if (loading) return <p className="text-xs text-ink-3">Looking for the loan money in your imported statement…</p>;
  return (
    <div className="space-y-1.5" data-testid="add-loan-statement-line">
      {candidates.length > 0 ? (
        <fieldset className="space-y-1">
          <legend className={labelCls}>The loan money in your statement</legend>
          {candidates.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-sm text-ink cursor-pointer">
              <input type="radio" name="add-loan-statement-line" className="mt-1" checked={chosen?.id === c.id}
                onChange={() => onPick(c.id)} />
              <span className="min-w-0">
                <span className="font-mono tabular-nums">{formatDate(c.txn_date)} · {rupee(Number(c.credit))}</span>
                <span className="text-ink-2 break-words"> · {c.description || "Money in"}</span>
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
            <input type="radio" name="add-loan-statement-line" className="mt-1" checked={!chosen}
              onChange={() => onPick(NOT_IN_STATEMENT)} />
            <span>Not in my imported statement — add a new money-in line</span>
          </label>
          {chosen && (
            <p className="text-xs text-ink-3">
              This line is reconciled to the loan — no new bank entry is made. The loan is dated {formatDate(chosen.txn_date)}, the day the money came in.
            </p>
          )}
        </fieldset>
      ) : (
        <p className="text-xs text-ink-3">
          No unmatched money-in line of {rupee(principal)} on this account
          {window ? ` from ${formatDate(window.from)} to ${formatDate(window.to)}` : ""}.
        </p>
      )}
      {!chosen && (
        <p className="text-xs text-amber-ink">
          A new money-in line will be added. Only if this credit is not in your imported statement — otherwise it is counted twice.
        </p>
      )}
    </div>
  );
}
