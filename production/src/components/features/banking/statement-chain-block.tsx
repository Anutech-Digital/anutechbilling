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
  return `${g.pages ? `Page ${pagesLabel(g.pages)}: ` : ""}${rupee(Math.abs(g.amount))} ki lines chhoot rahi hain — ${formatDate(g.after)} se ${formatDate(g.by)}`;
}

export function StatementChainBlock({ check, source, ack, onAck, note }: Props) {
  if (!check.blocking) {
    return (
      <div className="mb-2 space-y-1">
        {check.ran ? (
          <p className="text-xs text-emerald flex items-start gap-1.5">
            <Icon name="check_circle" size={13} className="mt-0.5 shrink-0" />
            <span>Balance chain poori — har line ka balance pichhli line se milta hai, koi line chhooti nahi.</span>
          </p>
        ) : (
          <p className="text-xs text-amber-ink flex items-start gap-1.5">
            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
            <span>
              <b>Balance check nahi chal paaya</b> — is statement mein running balance (Balance column) nahi hai, isliye
              ye pakka nahi keh sakte ki saari lines aayi hain. Import ke baad bank ke closing balance se zaroor milao.
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
            ? "Statement ki kuch lines is preview mein nahi hain — AI ne chhod di."
            : "Ye file adhoori hai — statement ki kuch lines isme nahi hain."}
        </span>
      </p>
      <p className="text-xs text-ink-3 mt-0.5 pl-5">
        {check.gaps.length > 0
          ? "Har line ka running balance pichhli line se milaya: in jagah balance ka hisaab nahi baithta."
          : "AI ne in pages par jitni lines gini, utni likhi nahi — aur balance column nahi hai jo poora hona saabit kare."}
      </p>

      <ul className="mt-2 space-y-1 pl-5 text-xs text-ink-2">
        {check.gaps.map((g) => (
          <li key={`${g.after}-${g.by}`}>
            • <b>{gapText(g)}</b>
            <span className="text-ink-3">
              {g.amount > 0
                ? " (itna paisa bank se gaya, uski line yahan nahi)"
                : " (itna paisa bank mein aaya, uski line yahan nahi — ya koi line do baar aa gayi)"}
            </span>
          </li>
        ))}
        {check.rowCountIssues.map((i) => (
          <li key={`rc-${i.pages.from}-${i.pages.to}`}>
            • <b>Page {pagesLabel(i.pages)}: AI ne {i.counted} lines gini, par {i.returned} hi likhi</b>
          </li>
        ))}
      </ul>

      {note && <p className="mt-2 pl-5 text-xs text-ink-3">{note}</p>}

      <p className="mt-2 pl-5 text-xs text-ink-2 leading-relaxed">
        <b>Sabse pakka:</b>{" "}
        {source === "ai"
          ? "net banking se isi period ka statement CSV / Excel (\"Delimited\") download karke import karo — usme AI nahi lagta, koi line nahi chhoot-ti."
          : "bank se poori period ka statement dobara CSV / Excel download karo (\"Recent transactions\" nahi — woh sirf aakhri 20 dikhata hai) aur wahi import karo."}
      </p>

      <label className="mt-2 pl-5 flex items-start gap-2 cursor-pointer text-xs text-ink">
        <input
          type="checkbox"
          className="mt-0.5 accent-rose"
          checked={ack}
          onChange={(e) => onAck(e.target.checked)}
        />
        <span>
          <b>Main jaanta hoon, adhoora import karna hai</b>
          <span className="block text-ink-3">Chhooti hui lines baad mein alag se import karni hongi, warna bank balance galat dikhega.</span>
        </span>
      </label>
    </div>
  );
}
