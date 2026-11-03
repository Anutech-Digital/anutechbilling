"use client";
/**
 * R-2408 — age tiles above the Payment Follow-up list (maths in worklist.ts ageTiles). Each tile
 * is a button: pressing it shows exactly the customers it counts; pressing the pressed tile
 * again goes back to the default (Overdue). Same pattern as Renewals (R-2405 tiles-card.tsx).
 */
import * as React from "react";
import { cn, rupee } from "@/lib/utils";
import { AGE_KEYS, AGE_LABEL, type AgeKey, type AgeTiles, type AgeView } from "./worklist";

const TONE: Record<AgeKey, string> = {
  overdue: "text-rose-600",
  d30: "text-ink",
  d60: "text-amber-ink",
  d90: "text-rose-600",
  d90plus: "text-rose-600",
  notDue: "text-ink-3",
};

const customers = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;

export function AgeTileRow({ tiles, active, onPick }: { tiles: AgeTiles; active: AgeView; onPick: (key: AgeKey) => void }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" role="group" aria-label="Amount due by age — press one to list those customers">
      {AGE_KEYS.map((key) => {
        const f = tiles[key];
        const sub = f.renewals > 0 ? `${customers(f.count)} · + ${rupee(f.renewals, { compact: true })} renewals` : customers(f.count);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            onClick={() => onPick(key)}
            title={`${AGE_LABEL[key]}: ${rupee(f.amount)} due — ${sub}. Age = the customer's oldest unpaid line. Press to list them.`}
            className={cn(
              "min-w-0 rounded-lg border bg-paper px-3 py-2 text-left transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              active === key ? "border-amber bg-amber-soft" : "border-hairline hover:border-amber/60",
            )}
          >
            <p className="truncate text-3xs font-semibold uppercase tracking-wider text-ink-3">{AGE_LABEL[key]}</p>
            <p className={cn("font-serif text-lg font-bold leading-tight tabular-nums", TONE[key])}>{rupee(f.amount, { compact: true })}</p>
            <p className="truncate text-2xs text-ink-2">{sub}</p>
          </button>
        );
      })}
    </div>
  );
}
