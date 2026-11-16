"use client";
/**
 * R-2405 — the tiles at the top of Renewals (maths in tiles.ts). Each tile is a button: pressing
 * it shows exactly the rows it adds up in the queue below; pressing it again (or "Back to tabs")
 * goes back to the time-window tabs.
 */
import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { TILE_KEYS, TILE_LABEL, TILE_VIEW_LABEL, windowExtraNote, type MonthRange, type RenewalTiles, type TileKey, type WindowKey, type WindowReconcile } from "./tiles";

const TONE: Record<TileKey, string> = {
  overdue: "text-rose-600",
  due30: "text-rose-600",
  due60: "text-amber-ink",
  due90: "text-ink",
  wontRenew: "text-rose-600",
  renewedMonth: "text-emerald-ink",
};

const plural = (n: number) => `${n} renewal${n === 1 ? "" : "s"}`;

function tileLines(key: TileKey, t: RenewalTiles, month: MonthRange, windows: Partial<Record<WindowKey, WindowReconcile>>): { value: string; full: string; sub: string; hint: string } {
  if (key === "renewedMonth") {
    const f = t.renewedMonth;
    return {
      value: rupee(f.amount, { compact: true }),
      full: rupee(f.amount),
      sub: f.pct == null ? `Nothing due in ${month.label}` : `${f.pct}% of ${rupee(f.dueAmount, { compact: true })} due in ${month.label}`,
      hint: f.stillDue.count > 0 ? `${rupee(f.stillDue.amount, { compact: true })} still due (Overdue + Due tiles)` : "Nothing left to chase",
    };
  }
  const f = t[key];
  const w = key in windows ? windows[key as WindowKey] : undefined;
  const extra = w ? windowExtraNote(w) : "";   // R-2741: "(+1 won't renew)" — the tab lists it, the tile does not
  return {
    value: rupee(f.amount, { compact: true }),
    full: rupee(f.amount),
    sub: extra ? `${plural(f.count)} ${extra}` : plural(f.count),
    hint: key === "wontRenew" ? "Revenue leaving" : "Renewal amount",
  };
}

export function RenewalTileRow({
  tiles, month, active, onPick, windows = {}, narrowed = false,
}: {
  tiles: RenewalTiles;
  month: MonthRange;
  active: TileKey | null;
  onPick: (key: TileKey) => void;
  /** R-2741: per tile, the closed rows its tabs list beyond it. */
  windows?: Partial<Record<WindowKey, WindowReconcile>>;
  /** R-2741: a search / filter is on — the tiles still count ALL renewals, and say so. */
  narrowed?: boolean;
}) {
  return (
    <div className="mb-3">
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 min-[1260px]:grid-cols-6" role="group" aria-label="Renewal totals — press one to list its renewals">
      {TILE_KEYS.map((key) => {
        const l = tileLines(key, tiles, month, windows);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => onPick(key)}
            title={`${TILE_LABEL[key]}: ${l.full} — ${l.sub} — ${l.hint}. Press to list them.`}
            className={cn(
              "min-w-0 rounded-lg border bg-paper px-3 py-2 text-left transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              active === key ? "border-amber bg-amber-soft" : "border-hairline hover:border-amber/60",
            )}
          >
            <p className="truncate text-3xs font-semibold uppercase tracking-wider text-ink-3">{TILE_LABEL[key]}</p>
            {/* R-2821: ONE compact row — label, then the amount with its count beside it; the hint sits in the tooltip */}
            <p className="flex min-w-0 items-baseline gap-1.5">
              <span className={cn("shrink-0 font-serif text-lg font-bold tabular-nums", TONE[key])}>{l.value}</span>
              <span className="truncate text-2xs text-ink-2">{l.sub}</span>
            </p>
            {/* the hint is kept for screen readers (the tooltip is the sighted way) */}
            <span className="sr-only">{l.hint}</span>
          </button>
        );
      })}
    </div>
    {narrowed && (
      <p className="mt-1 text-2xs text-ink-3" data-testid="renewal-tiles-all-note">
        These totals are for all renewals — the search and filters only narrow the list below.
      </p>
    )}
    </div>
  );
}

/** Replaces the tab bar while a tile is pressed: what the table shows, and the way back. */
export function TileViewBar({ tile, count, note, onClear }: { tile: TileKey; count: number; note?: string; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline pb-2 text-sm">
      <span className="font-semibold text-ink">{TILE_VIEW_LABEL[tile]}</span>
      <span className="text-xs text-ink-3">{plural(count)}</span>
      {note && <span className="text-xs text-ink-3">{note}</span>}
      <button type="button" onClick={onClear} className="ml-auto inline-flex items-center gap-1 text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
        <Icon name="x" size={12} />
        Back to tabs
      </button>
    </div>
  );
}
