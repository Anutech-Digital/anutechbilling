"use client";
/**
 * R-2405 — the tiles at the top of Renewals (maths in tiles.ts). Each tile is a button: pressing
 * it shows exactly the rows it adds up in the queue below; pressing it again (or "Back to tabs")
 * goes back to the time-window tabs.
 */
import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { TILE_KEYS, TILE_LABEL, TILE_VIEW_LABEL, type MonthRange, type RenewalTiles, type TileKey } from "./tiles";

const TONE: Record<TileKey, string> = {
  overdue: "text-rose-600",
  due30: "text-rose-600",
  due60: "text-amber-ink",
  due90: "text-ink",
  wontRenew: "text-rose-600",
  renewedMonth: "text-emerald-ink",
};

const plural = (n: number) => `${n} renewal${n === 1 ? "" : "s"}`;

function tileLines(key: TileKey, t: RenewalTiles, month: MonthRange): { value: string; full: string; sub: string; hint: string } {
  if (key === "renewedMonth") {
    const f = t.renewedMonth;
    return {
      value: rupee(f.amount, { compact: true }),
      full: rupee(f.amount),
      sub: f.pct == null ? `Nothing due in ${month.label}` : `${f.pct}% of ${rupee(f.dueAmount, { compact: true })} due in ${month.label}`,
      hint: f.stillDue.count > 0 ? `${rupee(f.stillDue.amount, { compact: true })} still due — show` : "Nothing left to chase",
    };
  }
  const f = t[key];
  return {
    value: rupee(f.amount, { compact: true }),
    full: rupee(f.amount),
    sub: plural(f.count),
    hint: key === "wontRenew" ? "Revenue leaving" : "Renewal amount",
  };
}

export function RenewalTileRow({
  tiles, month, active, onPick,
}: {
  tiles: RenewalTiles;
  month: MonthRange;
  active: TileKey | null;
  onPick: (key: TileKey) => void;
}) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6" role="group" aria-label="Renewal totals — press one to list its renewals">
      {TILE_KEYS.map((key) => {
        const l = tileLines(key, tiles, month);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => onPick(key)}
            title={`${TILE_LABEL[key]}: ${l.full} — ${l.sub}. Press to list them.`}
            className={cn(
              "min-w-0 rounded-lg border bg-paper p-3 text-left transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              active === key ? "border-amber bg-amber-soft" : "border-hairline hover:border-amber/60",
            )}
          >
            <p className="truncate text-3xs font-semibold uppercase tracking-wider text-ink-3">{TILE_LABEL[key]}</p>
            <p className={cn("mt-0.5 font-serif text-lg font-bold tabular-nums", TONE[key])}>{l.value}</p>
            <p className="truncate text-2xs text-ink-2">{l.sub}</p>
            <p className="truncate text-2xs text-ink-3">{l.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Replaces the tab bar while a tile is pressed: what the table shows, and the way back. */
export function TileViewBar({ tile, count, onClear }: { tile: TileKey; count: number; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline pb-2 text-sm">
      <span className="font-semibold text-ink">{TILE_VIEW_LABEL[tile]}</span>
      <span className="text-xs text-ink-3">{plural(count)}</span>
      <button type="button" onClick={onClear} className="ml-auto inline-flex items-center gap-1 text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
        <Icon name="x" size={12} />
        Back to tabs
      </button>
    </div>
  );
}
