/**
 * StatementSignCheck — in the import preview: lines whose minus sign the file does not explain
 * (R-2508). A withdrawal printed "-20,000" can be a reversal (money back in, e.g. a failed ATM
 * withdrawal) or just a withdrawal written with a minus. With no running balance that moves by
 * the amount, the app does not guess: each such line is listed here and Import waits until the
 * owner presses Money in or Money out for it (lib/banking/statement-parse.ts applySignChoice).
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { ParsedRow } from "@/lib/banking/statement-parse";

interface Props {
  rows: readonly ParsedRow[];
  onChoose: (index: number, choice: "in" | "out") => void;
}

export function StatementSignCheck({ rows, onChoose }: Props) {
  const waiting = rows.flatMap((r, i) => (r.checkSign ? [{ r, i }] : []));
  if (waiting.length === 0) return null;
  const n = waiting.length;
  return (
    <div data-testid="sign-check" role="alert" className="mb-3 rounded-md border border-amber/40 bg-amber-soft/20 p-3">
      <p className="text-sm font-semibold text-amber-ink flex items-start gap-1.5">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span>Check the sign — {n} line{n === 1 ? "" : "s"}</span>
      </p>
      <p className="mt-1 text-xs text-ink-2">
        {n === 1 ? "This line has" : "These lines have"} a minus sign in the amount column, and the file has no running
        balance that shows whether it is money back in (a reversal, e.g. a failed ATM withdrawal) or money out.
        Import waits until you choose for each line.
      </p>
      <ul className="mt-2 space-y-1.5">
        {waiting.map(({ r, i }) => {
          // The line is held as the reversal reading: a minus in Withdrawal shows as a credit.
          const fromWithdrawal = r.credit > 0;
          const amount = fromWithdrawal ? r.credit : r.debit;
          return (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={r.description}>
                {formatDate(r.txn_date)} · {fromWithdrawal ? "Withdrawal" : "Deposit"} column shows −{rupee(amount)} · {r.description}
              </span>
              <Button type="button" size="sm" variant="default" onClick={() => onChoose(i, "in")}>
                Money in (reversal)
              </Button>
              <Button type="button" size="sm" variant="default" onClick={() => onChoose(i, "out")}>
                Money out
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
