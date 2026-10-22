/**
 * StatementChainBlock — in the import preview: does the statement hold every line? (R-1693)
 *
 * The check itself is lib/banking/statement-verify.ts (the same arithmetic as the account
 * page's statement check). This only says what it found:
 *  - chain complete → one quiet green line;
 *  - no running balance anywhere → the check did NOT run (never a pass it could not make);
 *  - lines missing → a red block naming each gap (page, amount, dates), the CSV/Excel way
 *    out, and the explicit tick the Import button waits for.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { pagesLabel } from "@/lib/banking/statement-chunks";
import type { PreviewCheck, PreviewGap } from "@/lib/banking/statement-verify";

interface Props {
  check: PreviewCheck;
  /** "ai" = read from a PDF/photo; "csv" = a CSV / Excel file (a break there is a bad file). */
  source: "ai" | "csv";
  ack: boolean;
  onAck: (ack: boolean) => void;
  /** What was re-read page by page, if anything. */
  note?: string | null;
}

export function gapText(g: PreviewGap): string {
  return `${g.pages ? `Page ${pagesLabel(g.pages)}: ` : ""}lines worth ${rupee(Math.abs(g.amount))} are missing — ${formatDate(g.after)} to ${formatDate(g.by)}`;
}

export function StatementChainBlock({ check, source, ack, onAck, note }: Props) {
  if (!check.blocking) {
    return (
      <div className="mb-2 space-y-1">
        {check.ran ? (
          <p className="text-xs text-emerald flex items-start gap-1.5">
            <Icon name="check_circle" size={13} className="mt-0.5 shrink-0" />
            <span>Balance chain complete — every line's balance follows from the previous line; no line is missing.</span>
          </p>
        ) : (
          <p className="text-xs text-amber-ink flex items-start gap-1.5">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            <span>
              <b>Balance check could not run</b> — this statement has no running balance (Balance column), so
              we cannot confirm that every line came through. After importing, match it with the bank's closing balance.
            </span>
          </p>
        )}
        {note && <p className="text-xs text-ink-3">{note}</p>}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-md border border-rose/40 bg-rose-soft/20 p-3" role="alert">
      <p className="text-sm font-semibold text-rose-ink flex items-start gap-1.5">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span>
          {source === "ai"
            ? "Some statement lines are missing from this preview — the AI skipped them."
            : "This file is incomplete — some statement lines are not in it."}
        </span>
      </p>
      <p className="text-xs text-ink-3 mt-0.5 pl-5">
        {check.gaps.length > 0
          ? "Each line's running balance was checked against the previous line: the balance does not add up at these points."
          : "The AI counted more lines on these pages than it returned — and there is no balance column to prove the statement is complete."}
      </p>

      <ul className="mt-2 space-y-1 pl-5 text-xs text-ink-2">
        {check.gaps.map((g) => (
          <li key={`${g.after}-${g.by}`}>
            • <b>{gapText(g)}</b>
            <span className="text-ink-3">
              {g.amount > 0
                ? " (this much left the bank, but its line is not here)"
                : " (this much came into the bank, but its line is not here — or a line appears twice)"}
            </span>
          </li>
        ))}
        {check.rowCountIssues.map((i) => (
          <li key={`rc-${i.pages.from}-${i.pages.to}`}>
            • <b>Page {pagesLabel(i.pages)}: the AI counted {i.counted} lines but returned only {i.returned}</b>
          </li>
        ))}
      </ul>

      {note && <p className="mt-2 pl-5 text-xs text-ink-3">{note}</p>}

      <p className="mt-2 pl-5 text-xs text-ink-2 leading-relaxed">
        <b>Safest:</b>{" "}
        {source === "ai"
          ? "download this period's statement as CSV / Excel (\"Delimited\") from net banking and import that — no AI is involved, so no line is missed."
          : "download the full period's statement again as CSV / Excel from the bank (not \"Recent transactions\" — it shows only the last 20) and import that."}
      </p>

      <label className="mt-2 pl-5 flex items-start gap-2 cursor-pointer text-xs text-ink">
        <input
          type="checkbox"
          className="mt-0.5 accent-rose"
          checked={ack}
          onChange={(e) => onAck(e.target.checked)}
        />
        <span>
          <b>I understand — import the incomplete statement anyway</b>
          <span className="block text-ink-3">The missing lines must be imported separately later, or the bank balance will be wrong.</span>
        </span>
      </label>
    </div>
  );
}
