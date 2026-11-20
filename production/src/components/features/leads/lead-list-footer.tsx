"use client";
/**
 * The strip under the lead grid — the hint line, row density, which columns show, and the
 * width reset. Moved verbatim out of LeadListView (S35, 28 Sep 2026).
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { type Density } from "@/components/features/leads/lead-list-grid";
import {
  DEFAULT_LEAD_COLS, LOCKED_COL, addColumn, addableColumns, canMove, leadColDef, moveColumn,
  removeColumn, sameColumns, type LeadColId,
} from "@/lib/leads/list-columns";

export interface LeadListFooterProps {
  density: Density;
  setDensity: (d: Density) => void;
  /** R-2970: the shown data columns, in order, and the setter that also remembers them. */
  shown: readonly LeadColId[];
  setShown: (next: LeadColId[]) => void;
  colW: Record<string, number>;
  resetWidths: () => void;
  /** Default columns, default order, widths fitted afresh. */
  resetColumns: () => void;
}

export function LeadListFooter({ density, setDensity, shown, setShown, colW, resetWidths, resetColumns }: LeadListFooterProps) {
  return (
    <div className="px-3 py-2 border-t border-hairline bg-paper-2/40 text-xs text-ink-3 flex items-center gap-2">
      <Icon name="info" size={11} />
      <span className="min-w-0 flex-1">
        Click any row to open the drawer · Tick a checkbox to enable bulk actions · Every row action lives under the ⋯ at its right · a red left edge means it needs you today, green means high value
      </span>
      {/* Reset SIRF tab dikhta hai jab kuch kheencha gaya ho — warna ye har waqt ek
          aisa button hota jo kuch na kare. Dikhna zaroori hai: double-click wala raasta
          tabhi kaam aata hai jab pata ho ki wo hai, aur galat drag ka pata aksar tab
          chalta hai jab layout pehle hi bikhar chuka ho. */}
      {/* ── Row ki unchai — teen padav, chunav user ka ─────────────────────────
          Research: bade monitor par saans chahiye, chhote par zyada rows. Ye faisla
          screen ke saath badalta hai, isliye ek hardcoded 45px sabke liye galat hi
          rehta. */}
      <div className="flex shrink-0 items-center gap-1 rounded border border-hairline p-0.5">
        {([
          ["compact", "Compact", 40],
          ["regular", "Default", 48],
          ["relaxed", "Comfortable", 56],
        ] as const).map(([key, label, px]) => (
          <button
            key={key}
            type="button"
            aria-pressed={density === key}
            title={`Row height ~${px}px`}
            onClick={() => {
              setDensity(key);
              try { window.localStorage.setItem("resellersos.leads.density", key); } catch { /* ok */ }
            }}
            className={cn(
              "rounded px-1.5 py-0.5 font-semibold",
              density === key ? "bg-ink text-paper" : "text-ink-3 hover:bg-paper-2",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Columns: Shown + Add a column (R-2970, 20 Nov 2026) ────────────────
          Pardeep: the menu should ADD columns, not only hide the fixed nine. Two parts:
          "Shown" (in order — move up / down, remove) and "Add a column" (fields the row
          already has). One click each; Reset to default brings back the default view.
          Contact is the sticky identity column, so it cannot be removed or moved.
          A popover, not a dropdown menu: every row holds two or three buttons, and a menu
          item closes the menu on click. */}
      <ColumnsMenu shown={shown} setShown={setShown} resetColumns={resetColumns} />

      {Object.keys(colW).length > 0 && (
        <button
          type="button"
          onClick={resetWidths}
          className="shrink-0 rounded border border-hairline px-1.5 py-0.5 font-semibold text-ink-2 hover:bg-paper-2"
        >
          Reset widths
        </button>
      )}
    </div>
  );
}

function ColumnsMenu({ shown, setShown, resetColumns }: {
  shown: readonly LeadColId[];
  setShown: (next: LeadColId[]) => void;
  resetColumns: () => void;
}) {
  const addable = addableColumns(shown);
  const isDefault = sameColumns(shown, DEFAULT_LEAD_COLS);
  const iconBtn =
    "flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-paper-2 hover:text-ink " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded border border-hairline px-1.5 py-0.5 font-semibold text-ink-2 hover:bg-paper-2"
        >
          Columns{isDefault ? "" : ` (${shown.length})`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0" aria-label="Choose list columns">
        <div className="max-h-[70vh] overflow-y-auto py-1">
          <p className="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wider text-ink-3">Shown</p>
          <ul aria-label="Shown columns">
            {shown.map((id) => {
              const label = leadColDef(id).label;
              const locked = id === LOCKED_COL;
              return (
                <li key={id} className="flex items-center gap-1 px-3 py-1 text-sm text-ink">
                  <span className="min-w-0 flex-1 truncate">
                    {label}
                    {locked && <span className="ml-1 text-xs text-ink-3">(always)</span>}
                  </span>
                  {!locked && (
                    <>
                      <button type="button" className={iconBtn} aria-label={`Move ${label} up`} title="Move up"
                        disabled={!canMove(shown, id, -1)} onClick={() => setShown(moveColumn(shown, id, -1))}>
                        <Icon name="chevron_up" size={14} />
                      </button>
                      <button type="button" className={iconBtn} aria-label={`Move ${label} down`} title="Move down"
                        disabled={!canMove(shown, id, 1)} onClick={() => setShown(moveColumn(shown, id, 1))}>
                        <Icon name="chevron_down" size={14} />
                      </button>
                      <button type="button" className={iconBtn} aria-label={`Remove ${label}`} title="Remove from the list"
                        onClick={() => setShown(removeColumn(shown, id))}>
                        <Icon name="x" size={14} />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {addable.length > 0 && (
            <>
              <p className="mt-1 border-t border-hairline px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wider text-ink-3">
                Add a column
              </p>
              <ul aria-label="Columns you can add">
                {addable.map((id) => {
                  const label = leadColDef(id).label;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-label={`Add ${label}`}
                        onClick={() => setShown(addColumn(shown, id))}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink-2 hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:bg-paper-2"
                      >
                        <Icon name="plus" size={14} className="text-emerald" /> {label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
        <div className="flex justify-end border-t border-hairline px-3 py-2">
          <button
            type="button"
            onClick={resetColumns}
            disabled={isDefault}
            className="rounded border border-hairline px-2 py-0.5 text-xs font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-50"
          >
            Reset to default
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
