/**
 * StatementSignCheck — in the import preview: lines whose minus sign the file does not explain
 * (R-2508). A withdrawal printed "-20,000" can be a reversal (money back in, e.g. a failed ATM
 * withdrawal) or just a withdrawal written with a minus; a deposit printed "-750" the other way
 * round. When the running balance next to the line does not show which, the app does not guess:
 * each such line is listed here and Import waits until the owner presses Money in or Money out
 * (lib/banking/statement-parse.ts applySignChoice).
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import { signChoiceDirections, type ParsedRow, type SignChoice } from "@/lib/banking/statement-parse";

interface Props {
  rows: readonly ParsedRow[];
  onChoose: (index: number, choice: SignChoice) => void;
  /** Lines that will not be imported (e.g. before a new opening date) — not asked about. */
  skip?: (r: ParsedRow) => boolean;
}

export function StatementSignCheck({ rows, onChoose, skip }: Props) {
  const waiting = rows.flatMap((r, i) => (r.checkSign && !skip?.(r) ? [{ r, i }] : []));
  if (waiting.length === 0) return null;
  const n = waiting.length;
  return (
    <div data-testid="sign-check" role="alert" className="mb-3 rounded-md border border-amber/40 bg-amber-soft/20 p-3">
      <p className="text-sm font-semibold text-amber-ink flex items-start gap-1.5">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span>Check the sign — {n} line{n === 1 ? "" : "s"}</span>
      </p>
      <p className="mt-1 text-xs text-ink-2">
        {n === 1 ? "This line has" : "These lines have"} a minus sign in the amount column, and the statement&apos;s
        running balance does not show whether the money came back (a reversal, e.g. a failed ATM withdrawal) or
        is an ordinary {n === 1 ? "entry" : "entries"} written with a minus. Import waits until you choose for each line.
      </p>
      <ul className="mt-2 space-y-1.5">
        {waiting.map(({ r, i }) => {
          const d = signChoiceDirections(r);
          // Money in first, then Money out — whichever reading each one is.
          const options: Array<{ dir: "in" | "out"; choice: SignChoice }> = [
            { dir: "in", choice: d.reversal === "in" ? "reversal" : "printed" },
            { dir: "out", choice: d.reversal === "out" ? "reversal" : "printed" },
          ];
          return (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={r.description}>
                {formatDate(r.txn_date)} · {d.column} column shows −{rupee(d.amount)} · {r.description}
              </span>
              {options.map((o) => (
                <Button key={o.dir} type="button" size="sm" variant="default" onClick={() => onChoose(i, o.choice)}>
                  {o.dir === "in" ? "Money in" : "Money out"}{o.choice === "reversal" ? " (reversal)" : ""}
                </Button>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
