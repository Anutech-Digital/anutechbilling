"use client";
/**
 * The strip under the lead grid — the hint line, row density, which columns show, and the
 * width reset. Moved verbatim out of LeadListView (S35, 28 Sep 2026).
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LEADLIST_COL_ORDER, type Density } from "@/components/features/leads/lead-list-grid";

export interface LeadListFooterProps {
  density: Density;
  setDensity: (d: Density) => void;
  hidden: ReadonlySet<string>;
  setHidden: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  colW: Record<string, number>;
  resetWidths: () => void;
}

export function LeadListFooter({ density, setDensity, hidden, setHidden, colW, resetWidths }: LeadListFooterProps) {
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

      {/* ── Column chhupana ────────────────────────────────────────────────────
          Research: column hide/reorder ke saath ek saaf reset bhi hona chahiye. Reorder
          jaan-boojh kar nahi banaya — wo drag-and-drop ka apna poora kaam hai, aur is
          table par asli dard "bahut zyada column" tha, "galat kram" nahi. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded border border-hairline px-1.5 py-0.5 font-semibold text-ink-2 hover:bg-paper-2"
          >
            Columns{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
            Show columns
          </DropdownMenuLabel>
          {LEADLIST_COL_ORDER
            /* `select` aur `actions` chhupaye nahi ja sakte: checkbox ke bina bulk
               action pahunch se bahar ho jata aur ⋯ ke bina row ka koi action nahi
               bachta — yaani ek dead end (CLAUDE.md §24). */
            .filter((id) => id !== "select" && id !== "actions")
            .map((id) => (
              <DropdownMenuItem
                key={id}
                className="cursor-pointer gap-2.5 py-2 capitalize"
                onSelect={(e) => {
                  e.preventDefault();          // menu khula rahe, kai toggle ek saath
                  setHidden((h) => {
                    const next = new Set(h);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    try {
                      window.localStorage.setItem("resellersos.leads.hiddenCols", JSON.stringify([...next]));
                    } catch { /* ok */ }
                    return next;
                  });
                }}
              >
                <Icon name={hidden.has(id) ? "square" : "check_circle"} size={14}
                  className={hidden.has(id) ? "text-ink-3" : "text-emerald"} />
                {id === "followup" ? "Follow-up" : id === "wait" ? "Wait" : id}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>

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
