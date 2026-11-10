/**
 * R-2522 — the import dialog's "Set opening balance from this statement" box, moved out of
 * import-statement-dialog.tsx (max-lines). Shown whenever the preview has lines: it used to render
 * only while the date was filled, so typing a date made the whole box disappear. Pure view — the
 * dialog owns the state and the checks (openingMoveCheck, the account's lines between the dates).
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { OpeningBalanceResult } from "@/lib/banking/opening-balance";
import type { OpeningMoveCheck } from "@/lib/banking/opening-move";
import type { BankWindowLine } from "@/lib/queries/bank";

export type ImportOpeningBoxProps = {
  account: { opening_balance: number; opening_balance_date: string } | null | undefined;
  opening: OpeningBalanceResult | null;
  openingDate: string;
  setOpeningDate: (d: string) => void;
  applyOpening: boolean;
  setApplyOpening: (v: boolean) => void;
  openingOn: boolean;
  moveCheck: OpeningMoveCheck | null;
  isOwner: boolean;
  acceptDifference: boolean;
  setAcceptDifference: (v: boolean) => void;
  acceptReason: string;
  setAcceptReason: (v: string) => void;
  reasonOk: boolean;
  REASON_MIN: number;
  windowMissing: boolean;
  windowError: boolean;
  onRetryWindow: () => void;
  manualInWindow: readonly BankWindowLine[];
  excludedCount: number;
};

export function ImportOpeningBox({
  account, opening, openingDate, setOpeningDate, applyOpening, setApplyOpening, openingOn, moveCheck,
  isOwner, acceptDifference, setAcceptDifference, acceptReason, setAcceptReason, reasonOk, REASON_MIN,
  windowMissing, windowError, onRetryWindow, manualInWindow, excludedCount,
}: ImportOpeningBoxProps) {
  return (
    <div data-testid="opening-box" className="rounded-md border border-hairline bg-paper-2/30 p-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 accent-amber"
          checked={applyOpening}
          disabled={!opening?.ok}
          onChange={(e) => setApplyOpening(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-semibold text-ink">Set opening balance from this statement</span>
          <span className="block text-xs text-ink-3">
            Currently {account ? <>{rupee(account.opening_balance)} as of {formatDate(account.opening_balance_date)}</> : "…"}
          </span>
        </span>
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <label htmlFor="opening-date" className="text-xs text-ink-2">As of</label>
        <input
          id="opening-date"
          type="date"
          value={openingDate}
          onChange={(e) => setOpeningDate(e.target.value)}
          className="rounded border border-hairline bg-paper px-2 py-0.5 text-2xs text-ink focus:outline-none focus:ring-2 focus:ring-amber"
        />
        {opening?.ok && (
          <span className="text-sm font-semibold tabular-nums text-ink">{rupee(opening.amount)}</span>
        )}
      </div>

      <div className="mt-1.5 pl-6 space-y-1 text-xs">
        {!opening && <p className="text-ink-3">Pick the &quot;As of&quot; date to read the opening balance from the statement.</p>}
        {opening && !opening.ok && <p className="text-rose-ink">{opening.reason}</p>}
        {opening?.ok && (
          <p className="text-ink-3">
            Balance just before the {formatDate(opening.firstLineDate)} line (its balance, plus its debit, minus its credit).
          </p>
        )}
        {opening?.ok && opening.firstLineDate > openingDate && (
          <p className="text-amber-ink flex items-start gap-1.5">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            <span>
              The statement&apos;s first line on or after {formatDate(openingDate)} is on {formatDate(opening.firstLineDate)}.
              This figure is the balance on {formatDate(openingDate)} only if nothing moved in between — check it against your passbook.
            </span>
          </p>
        )}
        {opening?.ok && opening.chainBreaks > 0 && (
          <p className="text-amber-ink flex items-start gap-1.5">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            <span>
              {opening.chainBreaks} line{opening.chainBreaks === 1 ? "" : "s"} where the running balance does not follow from the line before.
              Some lines may have been skipped while reading the statement — check before using this figure.
            </span>
          </p>
        )}
        {/* R-2522: lines printed out of order inside one day whose day-end balance is right —
            nothing is missing, so a note, not a warning (the chain box above agrees). */}
        {opening?.ok && opening.outOfOrder && (
          <p data-testid="out-of-order-note" className="text-ink-3 flex items-start gap-1.5">
            <Icon name="info" size={12} className="mt-0.5 shrink-0" />
            <span>
              Some lines are printed out of order within the day
              ({opening.outOfOrder.days.map((d) => formatDate(d)).join(", ")}); each day&apos;s closing balance is right, so nothing is missing.
            </span>
          </p>
        )}
        {windowMissing && (
          <p data-testid="opening-move-loading" className={windowError ? "text-rose-ink" : "text-ink-3"}>
            {windowError ? (
              <>
                Could not load the lines already in this account between these dates, so the opening cannot be checked.{" "}
                <button type="button" className="underline" onClick={onRetryWindow}>Try again</button>
              </>
            ) : "Checking the lines already in this account between these dates…"}
          </p>
        )}
        {moveCheck?.kind === "earlier" && (
          <div
            data-testid="opening-move-check"
            className={`mt-1 rounded border px-2 py-1.5 ${moveCheck.matches ? "border-emerald/30 bg-emerald-50 text-emerald-ink" : "border-rose/30 bg-rose-50 text-rose-ink"}`}
          >
            <p>
              By this statement the balance at the start of {formatDate(moveCheck.oldDate)} is{" "}
              <b className="tabular-nums">{rupee(moveCheck.balanceOnOldDate)}</b>; the current opening on that date is{" "}
              <b className="tabular-nums">{rupee(moveCheck.oldOpening)}</b>.
            </p>
            {moveCheck.linesOnOldDate > 0 && (
              <p>
                Includes {moveCheck.linesOnOldDate} new line{moveCheck.linesOnOldDate === 1 ? "" : "s"} dated {formatDate(moveCheck.oldDate)} (or with
                a value date before it) — the bank counts {moveCheck.linesOnOldDate === 1 ? "it" : "them"} in the balance the current opening was taken from.
              </p>
            )}
            {moveCheck.roundingDrift !== 0 && (
              <p>
                This is the statement&apos;s own balance; its amounts rounded to whole rupees add up to {rupee(Math.abs(moveCheck.roundingDrift))}{" "}
                {moveCheck.roundingDrift < 0 ? "less" : "more"} (paise rounding, not a missing line).
              </p>
            )}
            {moveCheck.matches ? (
              <p>It matches the current opening, so today&apos;s balance stays the same. The old opening is kept in the account&apos;s history.</p>
            ) : (
              <>
                <p>
                  It differs by {moveCheck.difference < 0 ? "−" : "+"}{rupee(Math.abs(moveCheck.difference))}, so today&apos;s balance would change by that much.
                  A line may be missing from the statement, or the date may be wrong — check the preview and the date.
                </p>
                {isOwner ? (
                  <>
                    <label className="mt-1 flex items-start gap-2 cursor-pointer text-ink">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-amber"
                        checked={acceptDifference}
                        onChange={(e) => setAcceptDifference(e.target.checked)}
                      />
                      <span>The figures differ — set it anyway (the difference is recorded in the account&apos;s history)</span>
                    </label>
                    {acceptDifference && (
                      <div className="mt-1 pl-6">
                        <label htmlFor="opening-accept-reason" className="block text-ink-2">Why do the figures differ? (required, kept in the history)</label>
                        <textarea
                          id="opening-accept-reason"
                          rows={2}
                          value={acceptReason}
                          onChange={(e) => setAcceptReason(e.target.value)}
                          placeholder="e.g. Passbook checked — the bank reversed a charge after the statement date"
                          className="mt-0.5 w-full rounded border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                        />
                        {!reasonOk && <p className="text-rose-ink">Write the reason ({REASON_MIN}+ characters) to import.</p>}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="font-semibold">Only the owner can accept a difference — ask the owner to import this statement.</p>
                )}
              </>
            )}
          </div>
        )}
        {/* R-2522: hand-entered lines between the two dates now count — one may be the same
            payment as a statement line. */}
        {moveCheck?.kind === "earlier" && manualInWindow.length > 0 && (
          <div data-testid="manual-in-window" className="text-amber-ink flex items-start gap-1.5">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            <div>
              {manualInWindow.length} hand-entered line{manualInWindow.length === 1 ? " is" : "s are"} already in this account
              between {formatDate(openingDate)} and {formatDate(moveCheck.oldDate)}; after this move {manualInWindow.length === 1 ? "it counts" : "they count"} too.
              If {manualInWindow.length === 1 ? "it is" : "one is"} the same payment as a statement line, delete it on the transactions page first:
              <ul className="mt-0.5 ml-4 list-disc">
                {manualInWindow.slice(0, 5).map((l) => (
                  <li key={l.id}>{formatDate(l.txn_date)} · {l.debit ? `${rupee(l.debit)} out` : `${rupee(l.credit)} in`} · {l.description || "—"}</li>
                ))}
                {manualInWindow.length > 5 && <li>…and {manualInWindow.length - 5} more</li>}
              </ul>
            </div>
          </div>
        )}
        {openingOn && excludedCount > 0 && (
          <p className="text-ink-2">
            {excludedCount} line{excludedCount === 1 ? "" : "s"} dated before {formatDate(openingDate)} will <b>not</b> be imported — the opening balance already includes {excludedCount === 1 ? "it" : "them"}.
          </p>
        )}
      </div>
    </div>
  );
}
