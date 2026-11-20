/**
 * R-2949 (G-RECON) — the two lists of the "FY sales from Zoho" dialog that let the owner decide
 * what comes in:
 *
 *   ToImportList  — the invoices that WILL be imported (number, date, customer, total, a short
 *                   TDS / adjustment note), each with "Leave out", and one "Leave out numbers
 *                   starting with …" rule (a closed business line's series).
 *   LeftOutByYou  — what the owner left out, each with "Take back".
 *
 * Light on purpose: the rows come with the preview (at most TO_IMPORT_LIST_MAX), nothing is
 * fetched per row, and the list scrolls inside its own box. The server keeps the left-out list and
 * applies it to preview, Check first and Import (route.ts) — this file only asks.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, rupee } from "@/lib/utils";
import { cleanPrefix, type LeftOutView, type ToImportRow } from "@/lib/integrations/zoho-books/sales-import/left-out";

const HEADING = "text-3xs uppercase tracking-wider text-ink-3 font-semibold";
const invoices = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "invoice" : "invoices"}`;

/** TDS on the invoice and Zoho's adjustment, in a few words ("—" when neither). */
export function saleNote(r: Pick<ToImportRow, "tds" | "tdsSection" | "adjustment">): string {
  const parts: string[] = [];
  if (r.tds) parts.push(`TDS ${rupee(r.tds)}${r.tdsSection ? ` (${r.tdsSection})` : ""}`);
  if (r.adjustment) parts.push(`Adjustment ${rupee(r.adjustment)}`);
  return parts.join(" · ") || "—";
}

export function ToImportList({ rows, more, disabled, onLeaveOut, onLeaveOutPrefix }: {
  rows: ToImportRow[];
  /** To-import invoices beyond the rows sent. */
  more: number;
  disabled: boolean;
  onLeaveOut: (zohoId: string) => void;
  /** Resolves true when the rule was saved (the box is cleared). */
  onLeaveOutPrefix: (prefix: string) => Promise<boolean>;
}) {
  const [prefix, setPrefix] = React.useState("");
  return (
    <div data-testid="fy-sales-to-import">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-1">
        <p className={HEADING}>To import</p>
        <form className="flex items-center gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (await onLeaveOutPrefix(prefix)) setPrefix("");
        }}>
          <label htmlFor="fy-sales-leave-out-prefix" className="text-xs text-ink-2">Leave out numbers starting with</label>
          <Input id="fy-sales-leave-out-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. LS" maxLength={24} className="h-8 w-24" />
          <Button type="submit" size="sm" disabled={disabled || !cleanPrefix(prefix)}>Leave out</Button>
        </form>
      </div>
      <div className="border border-hairline rounded-md max-h-56 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-paper-2 border-b border-hairline sticky top-0">
            <tr>
              <th scope="col" className="p-2 text-left font-semibold text-ink-3">Number</th>
              <th scope="col" className="p-2 text-left font-semibold text-ink-3">Date</th>
              <th scope="col" className="p-2 text-left font-semibold text-ink-3">Customer</th>
              <th scope="col" className="p-2 text-right font-semibold text-ink-3">Total</th>
              <th scope="col" className="p-2 text-left font-semibold text-ink-3">TDS / adjustment</th>
              <th scope="col" className="p-2 text-right font-semibold text-ink-3"><span className="sr-only">Leave out</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.zohoId} className="border-b border-hairline last:border-0">
                <td className="p-2 font-mono whitespace-nowrap">{r.number}</td>
                <td className="p-2 whitespace-nowrap text-ink-2">{formatDate(r.date)}</td>
                <td className="p-2 text-ink-2 max-w-[16rem] truncate" title={r.customer}>{r.customer}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{rupee(r.amount)}</td>
                <td className="p-2 text-ink-2 whitespace-nowrap">{saleNote(r)}</td>
                <td className="p-1 text-right whitespace-nowrap">
                  <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Leave out ${r.number}`} onClick={() => onLeaveOut(r.zohoId)}>Leave out</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && (
        <p className="mt-1 text-xs text-ink-3">
          Showing the first {rows.length.toLocaleString("en-IN")} of {(rows.length + more).toLocaleString("en-IN")} — all of them will be imported.
        </p>
      )}
    </div>
  );
}

export function LeftOutByYou({ view, disabled, onTakeBack }: {
  view: LeftOutView;
  disabled: boolean;
  onTakeBack: (what: { zohoId: string } | { prefix: string }) => void;
}) {
  if (!view.prefixes.length && !view.invoices.length) return null;
  return (
    <div data-testid="fy-sales-left-out-by-you" className="mb-2">
      <p className="text-xs font-medium text-ink mb-0.5">Left out by you</p>
      <ul className="text-xs text-ink-2 space-y-0.5 max-h-40 overflow-y-auto">
        {view.prefixes.map((p) => (
          <li key={`p-${p.prefix}`} className="flex items-center justify-between gap-2">
            <span>Numbers starting with <span className="font-mono text-ink">{p.prefix}</span> · {invoices(p.count)}{p.count ? ` · ${rupee(p.amount)}` : ""}</span>
            <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Take back numbers starting with ${p.prefix}`} onClick={() => onTakeBack({ prefix: p.prefix })}>Take back</Button>
          </li>
        ))}
        {view.invoices.map((i) => (
          <li key={`i-${i.zohoId}`} className="flex items-center justify-between gap-2">
            <span>
              <span className="font-mono">{i.number}</span>
              {i.date ? ` · ${formatDate(i.date)}` : ""}{i.customer ? ` · ${i.customer}` : ""}{i.amount !== null ? ` · ${rupee(i.amount)}` : ""}
              {i.by === "prefix" ? ` — starts with ${i.prefix}` : ""}
            </span>
            {i.by === "invoice" && (
              <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Take back ${i.number}`} onClick={() => onTakeBack({ zohoId: i.zohoId })}>Take back</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
