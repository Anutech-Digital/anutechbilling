/**
 * The money flow as a LIST, not a waterfall.
 *
 * ─── WHY THIS REPLACED THE WATERFALL AS THE DEFAULT ─────────────────────────
 * Pardeep's words, after using it: *"isko samjhane me dimag lagana pad raha hai"* — and
 * that Profit by Vendor was easier and more interactive. He was right, and the reason is
 * worth writing down because it applies to every chart in this app.
 *
 * Four things made the waterfall hard:
 *
 *   1. THE GAP. A floating bar leaves empty space above and below it, and the reader has
 *      no way to know whether the gap means something. It does not — it is geometry.
 *   2. TWO REDS AND TWO GREENS. Licence cost and Running costs were both red; Gross margin
 *      and Net profit both green. Five bars, three colours, and the reader has to decode
 *      which red is which before reading anything.
 *   3. A FLOATING BAR MEANS "SUBTRACTED". That is an analyst's convention. Nobody who has
 *      not been taught it can infer it, and being wrong about it silently inverts the
 *      chart.
 *   4. ₹67,000 IS STILL FOUR PIXELS. The scale problem survives every styling fix.
 *
 * Profit by Vendor works because it is a list of rows, each readable on its own line, with
 * a picture attached. So this is that shape:
 *
 *   • THREE HEADINGS a non-accountant reads instantly — Money in, Money out, What's left.
 *     The grouping does the work the colours were failing to do.
 *   • EVERY BAR STARTS AT THE LEFT. Comparing lengths from a shared baseline is the
 *     easiest judgement the eye makes; comparing floating rectangles is among the hardest.
 *   • THE NUMBER IS TEXT. A 7% row is unreadable as a bar and perfectly readable as
 *     "₹66,998 · 7% of sales", so the bar is decoration and the text is the data.
 *   • ROWS LOOK CLICKABLE. A chevron and a hover state, because the waterfall's bars were
 *     clickable and nothing said so.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { cn, rupee } from "@/lib/utils";
import { signedRupee } from "@/lib/accounting/net-figure";

export interface FlowRow {
  key: string;
  label: string;
  /**
   * ₹. For "in" and "out" rows always positive — `group` carries the direction. For
   * "left" rows the SIGNED result: a loss is negative and renders "−₹68,100" in rose
   * (R-1486 — it used to be passed through Math.abs() and read as a profit).
   */
  amount: number;
  /** Plain English, under the label. */
  hint?: string | null;
  /** Percent of revenue, when it helps. Shown beside the amount. */
  ofSalesPct?: number | null;
  group: "in" | "out" | "left";
  /** Opens the drill-down. Rows without one render as plain rows. */
  onOpen?: () => void;
  /** Renders the bar hatched and adds a badge — the figure is not a fact. */
  estimated?: boolean;
}

const GROUPS: { id: FlowRow["group"]; label: string; bar: string; text: string }[] = [
  { id: "in",   label: "Money in",     bar: "bg-amber/70",   text: "text-amber-ink" },
  { id: "out",  label: "Money out",    bar: "bg-rose/55",    text: "text-rose" },
  { id: "left", label: "What's left",  bar: "bg-emerald/70", text: "text-emerald" },
];

export function MoneyFlow({ rows, scale }: {
  rows: readonly FlowRow[];
  /** The figure every bar is measured against — revenue. */
  scale: number;
}) {
  const width = (n: number) => (scale > 0 ? Math.max(1.5, (n / scale) * 100) : 0);

  return (
    <div className="space-y-4">
      {GROUPS.map((g) => {
        const inGroup = rows.filter((r) => r.group === g.id);
        if (inGroup.length === 0) return null;

        return (
          <div key={g.id}>
            <div className="mb-1.5 text-3xs font-semibold uppercase tracking-wider text-ink-3">
              {g.label}
            </div>

            <div className="space-y-1">
              {inGroup.map((r) => {
                const clickable = !!r.onOpen;
                const loss = g.id === "left" && r.amount < 0;
                const Row = (
                  <>
                    {/* Label column — fixed so every bar starts at the same x. Bars that
                        start in different places cannot be compared by length, which is
                        the whole point of using length. */}
                    <span className="w-[38%] min-w-0 shrink-0 sm:w-[30%]">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-ink">{r.label}</span>
                        {r.estimated && <Badge kind="warning" size="sm">est.</Badge>}
                      </span>
                      {r.hint && (
                        <span className="block truncate text-xs text-ink-3">{r.hint}</span>
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span
                        className={cn("block h-4 rounded-sm", loss ? "bg-rose/55" : g.bar)}
                        style={{
                          width: `${width(Math.abs(r.amount))}%`,
                          ...(r.estimated
                            ? {
                                backgroundImage:
                                  "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 4px, transparent 4px 8px)",
                              }
                            : {}),
                        }}
                      />
                    </span>

                    {/* The number, as TEXT. A 7% row is unreadable as a bar and perfectly
                        readable as "₹66,998 · 7% of sales". */}
                    <span className="shrink-0 text-right">
                      <span className={cn("block font-mono text-[13px] tabular-nums", loss ? "text-rose" : g.text)}>
                        {g.id === "out" ? `−${rupee(r.amount)}` : g.id === "left" ? signedRupee(r.amount) : rupee(r.amount)}
                      </span>
                      {r.ofSalesPct != null && (
                        <span className="block text-xs text-ink-3 tabular-nums">
                          {r.ofSalesPct}% of sales
                        </span>
                      )}
                    </span>

                    <span className="w-4 shrink-0 text-ink-3">
                      {clickable && <Icon name="chevron_right" size={14} />}
                    </span>
                  </>
                );

                return clickable ? (
                  <button
                    key={r.key}
                    type="button"
                    onClick={r.onOpen}
                    title={`${r.label} — see the entries behind this`}
                    className="flex w-full items-center gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-paper-2/70"
                  >
                    {Row}
                  </button>
                ) : (
                  <div key={r.key} className="flex w-full items-center gap-3 px-1.5 py-1.5">
                    {Row}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
