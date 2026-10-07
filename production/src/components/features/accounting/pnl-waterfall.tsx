/**
 * The money-flow waterfall.
 *
 * Draws what `layoutWaterfall` computed and decides nothing itself — the running totals
 * are arithmetic with tests, and a chart that quietly re-derives them is a chart that can
 * disagree with the table beside it.
 *
 * ─── EVERY BAR IS A BUTTON ──────────────────────────────────────────────────
 * Clicking Revenue, Licence cost or Running costs opens the same drill-down dialog the
 * table rows use, so the chart is a way IN rather than a picture to look at. The two
 * subtotals are not clickable: there is no such thing as "the invoices behind gross
 * margin", and a button that opens an empty drawer teaches people to stop pressing
 * buttons.
 *
 * ─── AN ESTIMATE IS DRAWN DIFFERENTLY ───────────────────────────────────────
 * With no vendor bills recorded, the licence cost comes from the wholesale rate card. It
 * renders hatched. A solid bar is a claim about money that changed hands, and this one
 * has not — the reseller's own rate card says it should have.
 */
"use client";

import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { layoutWaterfall, type WaterfallInput, type HundredRupeeSplit } from "@/lib/accounting/waterfall";

/** Plot height in px. Labels live outside it, so this is the bars' own space. */
const PLOT_H = 176;

/**
 * "Of every ₹100 you invoice…" — one bar, three parts.
 *
 * ─── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 * A waterfall on a thin-margin business has a scale problem that no styling fixes:
 * ANUTECH's ₹67,000 profit against ₹9,14,376 of revenue is a bar four pixels tall beside
 * one that fills the plot. The chart is accurate and the most important number on it is
 * the one nobody can see.
 *
 * Normalising to ₹100 deletes the scale. "Of every ₹100 you invoice, ₹63 goes to Google,
 * ₹30 to running the business, ₹7 is yours" is a sentence an owner can carry to their
 * accountant. Lakhs are not.
 *
 * ─── AND A LOSS IS DRAWN AS ONE ─────────────────────────────────────────────
 * When the business spends more than it earns the profit share is negative — there is no
 * width to give it, so the bar shows only what was spent and the caption states the
 * shortfall in words. Clamping it to zero would draw a business breaking even while it
 * bleeds.
 */
export function HundredRupeeBar({ split, costLabel = "Vendor licences", costTo = "the vendor" }: {
  split: HundredRupeeSplit;
  /** What the cost-of-goods share is, in this business — licences, project salary, or both. */
  costLabel?: string;
  /** "goes to ___" in the caption. */
  costTo?: string;
}) {
  const { licence, running, profit, isLoss } = split;
  /* Widths are of the SPENT portion when losing, so the bar still fills its track and the
     reader is not left wondering what the empty space means. */
  const denom = isLoss ? licence + running : 100;
  const parts = [
    { key: "licence", label: costLabel, value: licence, cls: "bg-rose/60" },
    { key: "running", label: "Running the business", value: running, cls: "bg-amber/60" },
    ...(isLoss ? [] : [{ key: "profit", label: "Yours to keep", value: profit, cls: "bg-emerald/70" }]),
  ];

  return (
    <div>
      <div className="flex h-9 w-full overflow-hidden rounded-md">
        {parts.map((p) => (
          <div
            key={p.key}
            title={`${p.label} · ${rupee(p.value)} of every ₹100`}
            className={cn("flex items-center justify-center", p.cls)}
            style={{ width: `${(p.value / denom) * 100}%` }}
          >
            {/* The number goes IN the segment. A legend forces the eye to travel and
                match colours, which is the work the chart was supposed to save. */}
            {p.value >= 8 && (
              <span className="font-mono text-[12px] font-semibold text-ink tabular-nums">{rupee(p.value)}</span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-xs text-ink-2">
            <span aria-hidden className={cn("h-2.5 w-2.5 rounded-sm", p.cls)} />
            {p.label} <b className="font-mono tabular-nums text-ink">{rupee(p.value)}</b>
          </span>
        ))}
      </div>

      <p className="mt-2 text-[12px] leading-snug text-ink-2">
        {isLoss ? (
          <>
            Of every <b>₹100</b> you invoice, <b className="text-rose">{rupee(licence + running)} goes out</b> —
            that is <b className="text-rose">{rupee(Math.abs(profit))} more than you take in</b>. The business is
            spending faster than it sells.
          </>
        ) : (
          <>
            Of every <b>₹100</b> you invoice, <b>{rupee(licence)}</b> goes to {costTo}, <b>{rupee(running)}</b> to
            running the business, and <b className="text-emerald">{rupee(profit)} is yours</b>.
          </>
        )}
      </p>
    </div>
  );
}


export function PnlWaterfall({
  steps, onSelect, className,
}: {
  steps: readonly WaterfallInput[];
  /** Called with the step key for the three clickable bars. */
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const { bars, zeroFrac } = React.useMemo(() => layoutWaterfall(steps), [steps]);

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: PLOT_H }}>
        {bars.map((b) => {
          const clickable = !b.isTotal && !!onSelect;
          const h = Math.max(2, b.heightFrac * PLOT_H);   // 2px floor: a ₹0 bar still shows a tick
          const base = b.baseFrac * PLOT_H;

          const fill =
            b.direction === "total"
              ? (b.end >= 0 ? "bg-emerald/70" : "bg-rose/70")
              : b.direction === "up" ? "bg-amber/70" : "bg-rose/60";

          const Bar = (
            <span
              className={cn(
                "block w-full rounded-sm transition-opacity",
                fill,
                clickable && "group-hover:opacity-80",
              )}
              style={{
                height: h,
                marginBottom: base,
                /* The hatch. Inline because it is a generated pattern, not a token —
                   globals.css has no repeating-linear-gradient utility and inventing one
                   for a single chart would be a token nobody else uses (§5). */
                ...(b.estimated
                  ? {
                      backgroundImage:
                        "repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 4px, transparent 4px 8px)",
                    }
                  : {}),
              }}
            />
          );

          return (
            <div key={b.key} className="relative flex min-w-0 flex-1 flex-col justify-end" style={{ height: PLOT_H }}>
              {/* ── THE CONNECTOR ────────────────────────────────────────────
                  A dotted line from the top of this bar to where the next one begins.
                  Without it the five bars read as five separate quantities of different
                  sizes; with it they read as one running balance, which is the only thing
                  a waterfall is for. Drawn from the LEFT bar so it can extend into the
                  gap, and skipped on the last one. */}
              {b.connectorFrac !== null && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute border-t border-dashed border-ink-3/70"
                  style={{
                    bottom: b.connectorFrac * PLOT_H,
                    left: "8%",
                    right: "-16%",
                  }}
                />
              )}
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect?.(b.key)}
                  title={`${b.label} · ${rupee(b.magnitude)} — see the entries`}
                  className="group flex h-full w-full cursor-pointer flex-col justify-end rounded-sm focus:outline-none focus:ring-1 focus:ring-amber"
                >
                  {Bar}
                </button>
              ) : (
                <span title={`${b.label} · ${rupee(b.magnitude)}`} className="flex h-full flex-col justify-end">
                  {Bar}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* The zero line, drawn only when something went below it — otherwise it is just
          the bottom of the chart and a second rule there is noise. */}
      {zeroFrac > 0.001 && (
        <div
          aria-hidden
          className="relative"
          style={{ height: 0 }}
        >
          <div
            className="absolute left-0 right-0 border-t border-dashed border-ink-3/50"
            style={{ bottom: zeroFrac * PLOT_H }}
          />
        </div>
      )}

      {/* Labels under the bars. Amount first, because that is what the eye came for. */}
      <div className="mt-2 flex items-start gap-2 border-t border-hairline pt-2 sm:gap-3">
        {bars.map((b) => (
          <div key={b.key} className="min-w-0 flex-1">
            <div className={cn(
              "font-mono text-[12px] tabular-nums leading-tight",
              b.direction === "down" ? "text-rose" : b.direction === "total" ? "text-ink font-semibold" : "text-amber-ink",
            )}>
              {b.direction === "down" ? "−" : ""}{rupee(b.magnitude, { compact: true })}
            </div>
            <div className="truncate text-xs text-ink-2" title={b.label}>{b.label}</div>
            {b.hint && (
              <div className="text-xs leading-tight text-ink-3">{b.hint}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
