"use client";
/**
 * R-2405 — the tiles at the top of Renewals (maths in tiles.ts). Each tile is a button: pressing
 * it shows exactly the rows it adds up in the queue below; pressing it again (or "Back to tabs")
 * goes back to the time-window tabs.
 * R-2855: every word a tile shows comes from tiles.ts tileText; what the number IS sits under it on
 * screen (not only in the tooltip); while the page's data is still being read the tiles are
 * placeholders — a number is drawn once, from the final data, and never changes after that.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { TILE_KEYS, TILE_LABEL, TILE_VIEW_LABEL, TILES_BASIS_NOTE, tileText, type MonthRange, type RenewalTiles, type TileKey, type WindowKey, type WindowReconcile } from "./tiles";

const TONE: Record<TileKey, string> = {
  overdue: "text-rose-600",
  due30: "text-rose-600",
  due60: "text-amber-ink",
  due90: "text-ink",
  wontRenew: "text-rose-600",
  renewedMonth: "text-emerald-ink",
};

const plural = (n: number) => `${n} renewal${n === 1 ? "" : "s"}`;

const TILE_BOX = "min-w-0 rounded-lg border bg-paper px-3 py-2 text-left";
const TILE_LABEL_CLS = "truncate text-3xs font-semibold uppercase tracking-wider text-ink-3";

export function RenewalTileRow({
  tiles, month, active, onPick, windows = {}, narrowed = false, loading = false,
}: {
  tiles: RenewalTiles;
  month: MonthRange;
  active: TileKey | null;
  onPick: (key: TileKey) => void;
  /** R-2741: per tile, the closed rows its tabs list beyond it. */
  windows?: Partial<Record<WindowKey, WindowReconcile>>;
  /** R-2741: a search / filter is on — the tiles still count ALL renewals, and say so. */
  narrowed?: boolean;
  /**
   * R-2855: the quotes / documents the rows' statuses come from are still being read. A row can read
   * "Renewed" until its part bill is seen, so a tile drawn now would change (staging: Due in 30 days
   * ₹2.9L · 6, then ₹5.4L · 11). Placeholders of the same size until the final data — no number, no press.
   */
  loading?: boolean;
}) {
  return (
    <div className="mb-3">
    <div
      className="grid grid-cols-2 gap-2 md:grid-cols-3 min-[1260px]:grid-cols-6"
      role="group"
      aria-label="Renewal totals — press one to list its renewals"
      aria-busy={loading ? true : undefined}
    >
      {TILE_KEYS.map((key) => {
        if (loading) {
          return (
            <button key={key} type="button" disabled data-testid="renewal-tile-loading" className={cn(TILE_BOX, "cursor-default border-hairline")}>
              <p className={TILE_LABEL_CLS}>{TILE_LABEL[key]}</p>
              {/* the same two lines as a loaded tile (same height — nothing jumps when the numbers arrive) */}
              <p className="relative">
                <span className="font-serif text-lg font-bold">&nbsp;</span>
                <span aria-hidden className="skeleton-shimmer absolute inset-y-1.5 left-0 w-24 rounded" />
              </p>
              <p className="relative text-3xs">
                &nbsp;
                <span aria-hidden className="skeleton-shimmer absolute inset-y-0.5 left-0 w-28 rounded" />
              </p>
              <span className="sr-only">Loading</span>
            </button>
          );
        }
        const l = tileText(key, tiles, month, windows);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => onPick(key)}
            title={l.title}
            className={cn(
              TILE_BOX, "transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              active === key ? "border-amber bg-amber-soft" : "border-hairline hover:border-amber/60",
            )}
          >
            <p className={TILE_LABEL_CLS}>{TILE_LABEL[key]}</p>
            {/* R-2821: ONE compact row — label, then the amount with its count beside it */}
            <p className="flex min-w-0 items-baseline gap-1.5">
              <span className={cn("shrink-0 font-serif text-lg font-bold tabular-nums", TONE[key])}>{l.value}</span>
              <span className="truncate text-2xs text-ink-2">{l.sub}</span>
            </p>
            {/* R-2855: what the number is — on screen, under it (it was screen-reader / tooltip only) */}
            <p className="truncate text-3xs text-ink-3" data-testid={`renewal-tile-caption-${key}`}>{l.caption}</p>
          </button>
        );
      })}
    </div>
    {/* R-2855: the tiles' basis, once — so "₹4.5L overdue" is not read as "₹4.5L of unpaid bills" (that is the header line) */}
    <p className="mt-1 text-2xs text-ink-3" data-testid="renewal-tiles-basis-note">
      {TILES_BASIS_NOTE}
      {narrowed && (
        <span data-testid="renewal-tiles-all-note">{" "}These totals are for all renewals — the search and filters only narrow the list below.</span>
      )}
    </p>
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
