/**
 * R-526 — "Check these catalog items": rows whose billing unit and name disagree.
 *
 * A domain registration stored as ₹999 per seat per month reached a quote as ₹11,988 a year;
 * a one-time migration as an Annual ₹2,388 line. The quote now prices by each row's unit
 * (lib/catalog/billing-unit.ts), but an old row's unit is only what its old behaviour implied —
 * so the app LISTS the suspicious ones here and never changes a unit or a price by itself.
 * The owner opens each row, sets "How is it billed?" and checks the number.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { catalogUnitWarnings } from "@/lib/catalog/billing-unit";
import type { Item } from "@/lib/supabase/database.types";

export function CatalogUnitCheck({ items, onEdit }: { items: readonly Item[]; onEdit: (it: Item) => void }) {
  const warnings = React.useMemo(() => catalogUnitWarnings(items), [items]);
  if (warnings.length === 0) return null;
  const byId = new Map(items.map((i) => [i.id, i]));
  return (
    <div className="rounded-xl border border-amber/40 bg-amber-soft/40 p-4" role="status" data-testid="catalog-unit-check">
      <p className="text-sm font-semibold text-amber-ink flex items-center gap-1.5">
        <Icon name="alert" size={15} />
        Check {warnings.length === 1 ? "this catalog item" : `these ${warnings.length} catalog items`}
      </p>
      <ul className="mt-2 space-y-2">
        {warnings.map((w) => {
          const it = byId.get(w.id);
          return (
            <li key={w.id} className="flex items-start justify-between gap-3 text-xs text-ink-2 leading-relaxed">
              <span className="min-w-0">
                <b className="text-ink">{w.name}</b> — {w.reason}
              </span>
              {it && (
                <button
                  type="button"
                  onClick={() => onEdit(it)}
                  className="shrink-0 rounded-md border border-amber/60 px-2 py-1 text-2xs font-medium text-amber-ink hover:bg-amber-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                >
                  Edit item
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-ink-2 leading-relaxed">
        The app does not change units or prices by itself — open each item, set how it is billed and check the price.
      </p>
    </div>
  );
}
