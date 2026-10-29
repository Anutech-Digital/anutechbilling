/**
 * R-2098 — "Several quotes / invoices" on a money-in bank line: tick what the money pays (each
 * gets its full due, editable), optionally a new sale, and watch one bar — allocated / bank /
 * left. The rest is the customer's advance, or (≤ ₹50) a round-off. Rules in
 * lib/banking/credit-pay-for-multi.ts; CreditPayForSection owns the state and the save.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import { itemDetail, itemKey, kindLabel, type OpenItem } from "@/lib/banking/credit-pay-for";
import {
  ROUND_OFF_LIMIT, pickProblem, splitBarText, splitStateText,
  type SplitRest, type SplitSummary,
} from "@/lib/banking/credit-pay-for-multi";

interface Props {
  items: readonly OpenItem[];
  /** key → amount put on it (ticked items only). */
  picks: Readonly<Record<string, number>>;
  onToggle: (item: OpenItem) => void;
  onAmount: (key: string, amount: number) => void;
  saleOn: boolean;
  onSaleOn: (on: boolean) => void;
  saleAmount: number;
  saleTotal: number;
  onSaleAmount: (amount: number) => void;
  /** The new-sale editor (CreditPayForSection's own SaleEditor). */
  saleEditor: React.ReactNode;
  summary: SplitSummary;
  rest: SplitRest | null;
  restChoice: SplitRest;
  onRestChoice: (r: SplitRest) => void;
}

export function CreditPaySplit({
  items, picks, onToggle, onAmount, saleOn, onSaleOn, saleAmount, saleTotal, onSaleAmount, saleEditor,
  summary, rest, restChoice, onRestChoice,
}: Props) {
  const bar = splitBarText(summary);
  const pct = summary.credit > 0 ? Math.min(100, Math.round((summary.allocated / summary.credit) * 100)) : 0;
  const barCls = bar.tone === "ok" ? "bg-emerald" : bar.tone === "bad" ? "bg-rose" : "bg-amber";
  const saleProblem = saleOn && saleTotal > 0
    ? (saleAmount <= 0 ? "Enter an amount" : saleAmount > saleTotal ? `More than the ${rupee(saleTotal)} total` : null)
    : null;

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-xs text-ink-3">Nothing open for this customer — add a new sale below, or keep the money as an advance.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Open quotes and invoices to pay">
          {items.map((i) => {
            const k = itemKey(i);
            const on = k in picks;
            const problem = on ? pickProblem(i, picks[k]) : null;
            const doc = i.invoice_id ?? i.quote_id ?? "";
            return (
              <li key={k} className={`rounded-md border p-2 flex items-start gap-2 ${on ? "border-amber bg-amber/10" : "border-hairline bg-paper"}`}>
                <input type="checkbox" checked={on} onChange={() => onToggle(i)} className="mt-1 shrink-0" aria-label={`Pay ${doc}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge kind={i.kind === "renewal" ? "info" : i.kind === "add_seats" ? "warning" : i.kind === "new" ? "success" : "muted"} size="sm">
                      {kindLabel(i.kind)}
                    </Badge>
                    <span className="text-xs text-ink-3">Due {rupee(i.amount_due)} · {formatDate(i.doc_date)}</span>
                  </span>
                  <span className="block text-sm text-ink break-words mt-0.5">{itemDetail(i)}</span>
                  {problem && <span className="block text-xs text-rose-ink">{problem}</span>}
                </span>
                {on && (
                  <Input type="number" min={1} step={1} value={String(picks[k])} wrapperClassName="w-28 shrink-0" className="tabular-nums"
                    onChange={(e) => onAmount(k, Number(e.target.value))} aria-label={`Amount on ${doc}`} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
        <input type="checkbox" checked={saleOn} onChange={(e) => onSaleOn(e.target.checked)} />
        <span>Also a new sale (no quote yet)</span>
      </label>
      {saleOn && (
        <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
          {saleEditor}
          {saleTotal > 0 && (
            <label className="flex items-center justify-between gap-2 text-xs text-ink-3">
              <span className="min-w-0">Amount of this money on the new sale</span>
              <Input type="number" min={1} step={1} value={String(saleAmount)} wrapperClassName="w-28 shrink-0" className="tabular-nums"
                onChange={(e) => onSaleAmount(Number(e.target.value))} aria-label="Amount on the new sale" />
            </label>
          )}
          {saleProblem && <p className="text-xs text-rose-ink">{saleProblem}</p>}
        </div>
      )}

      {/* The bar: allocated / bank / left. */}
      <div className="rounded-md border border-hairline bg-paper px-2.5 py-2 space-y-1.5" role="status" aria-label="Allocation">
        <div className="flex flex-wrap justify-between gap-x-3 text-xs tabular-nums">
          <span className="text-ink-2">Allocated <b className="text-ink">{bar.allocated}</b></span>
          <span className="text-ink-2">Bank <b className="text-ink">{bar.bank}</b></span>
          <span className={bar.tone === "bad" ? "text-rose-ink" : "text-ink-2"}>Left <b>{bar.left}</b></span>
        </div>
        <div className="h-1.5 rounded-full bg-hairline overflow-hidden" aria-hidden>
          <div className={`h-full ${barCls}`} style={{ width: `${pct}%` }} />
        </div>
        <p className={`text-xs ${summary.state.kind === "over" ? "text-rose-ink" : "text-ink-3"}`}>{splitStateText(summary.state, rest)}</p>
        {summary.state.kind === "left" && summary.state.canRoundOff && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="What the money left over is">
            {([["advance", `Keep ${rupee(summary.state.left)} as advance`], ["round_off", `Write off ${rupee(summary.state.left)} as round-off`]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={restChoice === k} onClick={() => onRestChoice(k)}
                className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${restChoice === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {summary.state.kind === "short" && (
          <p className="text-xs text-ink-3">Up to {rupee(ROUND_OFF_LIMIT)} is written off; more than that — lower an amount so it stays due.</p>
        )}
      </div>
    </div>
  );
}
