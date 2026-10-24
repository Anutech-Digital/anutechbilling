/**
 * P&L statement row primitives — a line, an unknown line, the indented sub-lines (R-1833) and
 * the compare columns (R-1832). Moved out of page.tsx so the page stays readable.
 */
"use client";

import * as React from "react";
import { rupee } from "@/lib/utils";
import {
  periodChange, changeTone, formatChange, signedRupee, TONE_CLASS, MAX_SUB_LINES, type Sense, type SubLines,
} from "@/lib/accounting/pnl-compare";

/**
 * R-1832: one line's comparison. `now` / `was` are the figure in each period (costs as positive
 * rupees, shown with "−" when `neg`); null = not known for that period; `was` undefined = loading.
 */
export interface Cmp { now: number | null; was: number | null | undefined; sense: Sense; neg?: boolean }

/** The compare amount and the change — two columns from `sm` up, stacked under the amount on a phone. */
function CmpCells({ c, phone }: { c: Cmp; phone?: boolean }) {
  const was = c.was === undefined ? "…" : c.was === null ? "—" : signedRupee(c.was, c.neg);
  let change: React.ReactNode = c.was === undefined ? "" : "—";
  if (c.now !== null && c.was !== undefined && c.was !== null) {
    const d = periodChange(c.now, c.was);
    change = <span className={TONE_CLASS[changeTone(d.abs, c.sense)]}>{formatChange(d)}</span>;
  }
  if (phone) {
    return (
      <div className="sm:hidden text-xs text-ink-3 leading-snug mt-0.5 font-sans">
        <div>vs {was}</div>
        {change !== "" && <div>{change}</div>}
      </div>
    );
  }
  return (
    <>
      <div className="hidden sm:block w-28 shrink-0 text-right font-mono text-sm text-ink-3 whitespace-nowrap">{was}</div>
      <div className="hidden sm:block w-36 shrink-0 text-right text-xs whitespace-nowrap">{change}</div>
    </>
  );
}

export function Row({
  label, amount, hint, onHint, tone, emphasis, xl, cmp,
}: {
  label: React.ReactNode;
  amount: number;
  hint?: string;
  /** When set, the hint becomes a button that opens the drill-down popup. */
  onHint?: () => void;
  tone: "ink" | "emerald" | "rose";
  emphasis?: boolean;
  xl?: boolean;
  /** R-1832: the compare columns, when a comparison is on. */
  cmp?: Cmp;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className={`${emphasis ? "font-semibold" : ""} ${xl ? "text-base" : "text-sm"} text-ink leading-tight`}>
          {label}
        </div>
        {hint && (
          onHint
            ? <button type="button" onClick={onHint} className="text-xs text-amber-ink hover:underline mt-0.5 inline-flex items-center gap-0.5 text-left">{hint} <span aria-hidden>→</span></button>
            : <div className="text-xs text-ink-3 mt-0.5">{hint}</div>
        )}
      </div>
      <div className="flex items-baseline gap-3 shrink-0">
        <div className={cmp ? "text-right sm:min-w-[8rem]" : "text-right"}>
          <div className={`font-mono whitespace-nowrap ${xl ? "font-serif text-3xl" : emphasis ? "text-lg font-semibold" : "text-base"} ${colorClass}`}>
            {amount < 0 ? "−" : ""}{rupee(Math.abs(amount))}
          </div>
          {cmp && <CmpCells c={cmp} phone />}
        </div>
        {cmp && <CmpCells c={cmp} />}
      </div>
    </div>
  );
}

/**
 * R-1833: the indented sub-lines under a statement line (Revenue / Licence cost / Operating
 * expenses). They add up to the line above (lib/accounting/pnl-compare.ts). Past 8, the top 7
 * and one "Other", with Show all.
 */
export function SubRows({ group, cmpOn, cmpLoading, showAll, onToggleAll, onOpen }: {
  group: SubLines;
  cmpOn: boolean;
  cmpLoading: boolean;
  showAll: boolean;
  onToggleAll: () => void;
  onOpen: (line: SubLines["lines"][number]) => void;
}) {
  /* A single line equal to its parent says nothing new. */
  if (group.lines.length < 2) return null;
  return (
    <div className="space-y-1 border-l-2 border-hairline pl-3 ml-1" data-testid="pnl-sub-lines">
      {group.lines.map((l) => {
        const prefix = l.kind === "less" ? "−" : l.kind === "add" ? "+" : "";
        const c: Cmp | undefined = cmpOn
          ? { now: l.now, was: cmpLoading ? undefined : l.was, sense: l.sense }
          : undefined;
        const label = (
          <>
            {l.label}
            {l.estimated && <span className="ml-1 text-amber-ink">(estimated)</span>}
          </>
        );
        return (
          <div key={l.key} className="flex items-baseline justify-between gap-3 text-[13px]">
            {l.kind === "less" || l.kind === "add"
              ? <span className="min-w-0 text-ink-3">{label}</span>
              : (
                <button type="button" onClick={() => onOpen(l)}
                        className="min-w-0 text-left text-ink-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded">
                  {label}
                </button>
              )}
            <div className="flex items-baseline gap-3 shrink-0">
              <div className={c ? "text-right sm:min-w-[8rem]" : "text-right"}>
                <div className="font-mono whitespace-nowrap text-ink-2">{prefix}{rupee(l.now)}</div>
                {c && <CmpCells c={c} phone />}
              </div>
              {c && <CmpCells c={c} />}
            </div>
          </div>
        );
      })}
      {group.itemCount > MAX_SUB_LINES && (
        <button type="button" onClick={onToggleAll} className="text-xs text-amber-ink hover:underline">
          {showAll ? `Show top ${MAX_SUB_LINES - 1}` : `Show all ${group.itemCount}`}
        </button>
      )}
    </div>
  );
}

/** A statement line whose figure is not known — shown as words, never as ₹0. */
/** R-1649: why the project delivery cost is not shown to this role. */
export const HIDDEN_NOTE = "salary on projects — owner, manager and accountant see it";

export function UnknownRow({ label, value, note, large, cmpOn }: {
  label: React.ReactNode; value: string; note: string; large?: boolean;
  /** R-1832: keep the compare columns aligned — an unknown figure has no change. */
  cmpOn?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className={`${large ? "text-base font-semibold" : "text-sm"} text-ink leading-tight`}>{label}</div>
      <div className="flex items-baseline gap-3">
        <div className={cmpOn ? "text-right sm:min-w-[8rem]" : "text-right"}>
          <div className={`${large ? "font-serif text-2xl" : "text-base"} text-ink-3 italic`}>{value}</div>
          <div className="text-xs text-amber-ink">{note}</div>
        </div>
        {cmpOn && (
          <>
            <div className="hidden sm:block w-28 shrink-0 text-right text-sm text-ink-3">—</div>
            <div className="hidden sm:block w-36 shrink-0 text-right text-xs text-ink-3">not comparable</div>
          </>
        )}
      </div>
    </div>
  );
}

/** R-1832: a GST figure's compare line — neutral colour, GST simply follows sales and purchases. */
export function GstCompare({ now, was, name }: { now: number; was: number | undefined; name: string }) {
  if (was === undefined) return <div className="-mt-2 text-xs text-ink-3 text-right">vs …</div>;
  return (
    <div className="-mt-2 text-xs text-ink-3 text-right">
      vs {signedRupee(was)} in {name} · {formatChange(periodChange(now, was))}
    </div>
  );
}

export function Divider({ thick = false }: { thick?: boolean }) {
  return <div className={`my-2 border-t ${thick ? "border-ink-2 border-t-2" : "border-hairline"}`} />;
}
