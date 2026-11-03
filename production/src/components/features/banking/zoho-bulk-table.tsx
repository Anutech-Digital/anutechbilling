/**
 * R-2402 — the review table of "Reconcile from Zoho" (bulk): one row per open money-in line Zoho
 * has a payment for — date, amount, the Zoho payment and invoices, the customer (in the app / new
 * from Zoho), what each line does to subscriptions, and why a row is not ticked. Fits 1280px
 * (fixed columns, text wraps; the tick is the first column). Presentational only.
 */
"use client";

import * as React from "react";

import { rupee, formatDate } from "@/lib/utils";
import type { PlanLine, PlanRow } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { BookedRow } from "./zoho-bulk-book";

const ACTION_TONE: Record<PlanLine["action"], string> = {
  new_sub: "text-emerald-ink",
  existing_sub: "text-indigo-ink",
  add_seats: "text-indigo-ink",
  one_time: "text-ink-3",
  /* R-2419: a past-period charge / a charge on the run's newest subscription — no subscription. */
  past_charge: "text-amber-ink",
  charge_on_new: "text-ink-3",
};

interface Props {
  rows: readonly PlanRow[];
  ticked: ReadonlySet<string>;
  booked: ReadonlyMap<string, BookedRow>;
  onToggle: (txnId: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  disabled?: boolean;
}

export function ZohoBulkTable({ rows, ticked, booked, onToggle, onToggleAll, disabled }: Props) {
  const tickable = rows.filter((r) => r.book && !booked.has(r.txnId));
  const allOn = tickable.length > 0 && tickable.every((r) => ticked.has(r.txnId));
  return (
    <table className="w-full table-fixed border-collapse text-xs" aria-label="Plan per bank line">
      <colgroup>
        <col className="w-8" />
        <col className="w-[110px]" />
        <col className="w-[150px]" />
        <col className="w-[190px]" />
        <col />
        <col className="w-[240px]" />
      </colgroup>
      <thead className="sticky top-0 z-10 bg-paper">
        <tr className="border-b border-hairline text-left text-2xs uppercase tracking-wide text-ink-3">
          <th className="py-2 pl-1">
            <input
              type="checkbox" aria-label="Tick every row that can be booked" checked={allOn} disabled={disabled || tickable.length === 0}
              onChange={(e) => onToggleAll(e.target.checked)}
            />
          </th>
          <th className="py-2 pr-2">Bank line</th>
          <th className="py-2 pr-2">Zoho</th>
          <th className="py-2 pr-2">Customer</th>
          <th className="py-2 pr-2">Plan</th>
          <th className="py-2 pr-2">Check</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const done = booked.get(r.txnId) ?? null;
          const canTick = Boolean(r.book) && !done;
          return (
            <tr key={r.txnId} data-testid={`zoho-row-${r.txnId}`} className="border-b border-hairline align-top">
              <td className="py-2 pl-1">
                <input
                  type="checkbox"
                  aria-label={`Book the ${rupee(r.credit)} line of ${formatDate(r.txnDate)}`}
                  checked={canTick && ticked.has(r.txnId)}
                  disabled={disabled || !canTick}
                  onChange={(e) => onToggle(r.txnId, e.target.checked)}
                />
              </td>
              <td className="py-2 pr-2">
                <div className="font-medium text-ink tabular-nums">{rupee(r.credit)}</div>
                <div className="text-ink-3">{formatDate(r.txnDate)}</div>
                {r.tds > 0 && <div className="text-ink-3">+ TDS {rupee(r.tds)}</div>}
              </td>
              <td className="py-2 pr-2 break-words">
                {r.kind === "several"
                  ? <span className="text-ink-3">{r.zoho.candidates} possible payments</span>
                  : (
                    <>
                      <div className="text-ink">Payment {r.zoho.paymentNumber ?? "—"}</div>
                      <div className="text-ink-3">{r.zoho.invoiceNumbers.join(", ") || "No invoice"}</div>
                      <div className="text-ink-3">{r.zoho.by === "utr" ? "Matched by UTR" : "Matched by amount + date"}</div>
                    </>
                  )}
              </td>
              <td className="py-2 pr-2 break-words">
                {r.customer
                  ? (
                    <>
                      <div className="text-ink">{r.customer.name}</div>
                      {r.customer.kind === "new"
                        ? <div className="text-amber-ink">New from Zoho{r.customer.state ? ` · ${r.customer.state}` : ""}{r.customer.gstin ? ` · ${r.customer.gstin}` : ""}</div>
                        : <div className="text-ink-3">In the app</div>}
                      {r.payer?.differs && <div className="text-ink-3">Paid by {r.payer.name}{r.payer.record ? " (on the customer's behalf)" : ""}</div>}
                    </>
                  )
                  : <span className="text-ink-3">—</span>}
              </td>
              <td className="py-2 pr-2">
                {r.summary && <div className="mb-1 font-medium text-indigo-ink" data-testid={`zoho-summary-${r.txnId}`}>{r.summary}</div>}
                <ul className="space-y-1">
                  {r.lines.map((l, i) => (
                    <li key={i}>
                      <span className="text-ink">{l.qty} × {l.name}</span>
                      {l.domain && <span className="text-ink-3"> · {l.domain}</span>}
                      <span className="text-ink-3"> · {rupee(l.rate, { decimals: l.rate % 1 ? 2 : 0 })}</span>
                      {!r.summary && <div className={ACTION_TONE[l.action]}>{l.text}</div>}
                    </li>
                  ))}
                </ul>
                {r.seatDiffs.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-amber-ink">
                    {r.seatDiffs.map((d) => (
                      <li key={d.subId}>Seats differ: app {d.appSeats}, Zoho {d.zohoSeats} ({d.plan}{d.domain ? `, ${d.domain}` : ""})</li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="py-2 pr-2 break-words" data-testid={`zoho-check-${r.txnId}`}>
                {done ? (
                  <span className={done.outcome === "booked" ? "text-emerald-ink font-medium" : "text-amber-ink"}>{done.text}</span>
                ) : r.problems.length > 0 ? (
                  <ul className="space-y-0.5 text-rose-ink">{r.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                ) : (
                  <span className="text-emerald-ink">Ready</span>
                )}
                {!done && r.notes.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-ink-3">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
