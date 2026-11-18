/**
 * R-2920 — "A receipt on a loan you gave?": the list of loans as tick boxes. One bank line can pay
 * off two or more loans (₹3,50,000 = ₹3,49,000 left on one loan + a separate ₹1,000 loan), so each
 * ticked loan gets its own amount once more than one is ticked, and the tally line says whether the
 * amounts add up to the bank line. The maths is lib/accounting/loan-given-split.ts.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import type { LoanChoice, ReceiptPlan } from "@/lib/accounting/loan-given-split";

export function LoanGivenChoiceList({ choices, amount, owed, plan, typed, onToggle, onType }: {
  choices: readonly LoanChoice[];
  /** The bank line, whole rupees. */
  amount: number;
  /** loan id → the most that can come in on it on the line's date. */
  owed: ReadonlyMap<string, number>;
  plan: ReceiptPlan;
  /** loan id → what the owner typed (only used while two or more loans are ticked). */
  typed: Readonly<Record<string, string>>;
  onToggle: (loanId: string) => void;
  onType: (loanId: string, value: string) => void;
}) {
  const parts = new Map(plan.parts.map((p) => [p.loanId, p]));
  const many = plan.parts.length > 1;
  return (
    <>
      <ul className="space-y-1.5" role="group" aria-label="Which loan given">
        {choices.map((x) => {
          const part = parts.get(x.loanId);
          const max = owed.get(x.loanId);
          return (
            <li key={x.loanId} className={`rounded-md border px-3 py-2 ${part ? "border-indigo bg-paper" : "border-hairline"}`}>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={Boolean(part)} onChange={() => onToggle(x.loanId)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">Receipt {x.seq} · {x.borrowerName}</span>
                  <span className="block text-xs text-ink-3">
                    {x.expected !== null ? <>Expected {rupee(x.expected)}</> : "No fixed receipt"}
                    {x.expected !== null && x.expected !== amount && <> · this line is {rupee(Math.abs(amount - x.expected))} {amount > x.expected ? "more" : "less"}</>}
                    {max !== undefined && <> · owes {rupee(max)}</>}
                  </span>
                </span>
                {x.confidence === "exact" && <Badge kind="success" size="sm">Exact</Badge>}
              </label>
              {part && many && (
                <div className="mt-2 pl-6 space-y-1">
                  <div className="flex items-center gap-2">
                    <label htmlFor={`loan-given-part-${x.loanId}`} className="text-xs text-ink-2 shrink-0">Amount on this loan (₹)</label>
                    <Input
                      id={`loan-given-part-${x.loanId}`} type="number" min={1} step={1} inputMode="numeric" className="w-36"
                      aria-label={`Amount for ${x.borrowerName}, receipt ${x.seq}`}
                      value={typed[x.loanId] ?? String(part.amount)}
                      onChange={(e) => onType(x.loanId, e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-ink-3">
                    Principal back {rupee(part.principalPart)} · interest {rupee(part.interestPart)}
                    {part.closes && <span className="text-emerald"> · clears the loan</span>}
                  </p>
                  {part.tooMuch && <p className="text-xs text-rose-ink">More than is owed — at most {rupee(part.maxAmount)} can come in on this loan.</p>}
                  {part.amount <= 0 && <p className="text-xs text-rose-ink">Enter a whole-rupee amount, or untick this loan.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {many && (
        <p className={`text-sm font-medium ${plan.tallies ? "text-emerald" : "text-rose-ink"}`} data-testid="loan-given-tally" role="status">
          {plan.tallies
            ? <>Bank {rupee(amount)} = {rupee(plan.total)} ✓</>
            : <>Bank {rupee(amount)} ≠ {rupee(plan.total)} — {rupee(Math.abs(plan.difference))} {plan.difference < 0 ? "still to place" : "too much"}</>}
        </p>
      )}
    </>
  );
}
