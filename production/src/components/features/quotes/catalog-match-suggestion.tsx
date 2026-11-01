"use client";
/**
 * R-2028 (1) — under a hand-typed quote line with no cost: "Is this <catalogue item>?
 * Use cost ₹X (<commitment>)". One click links the item and fills its cost for the line's
 * commitment (the builder's `onUse`); the typed sell price is left exactly as typed.
 * Shows nothing for a line already linked, a line whose cost is known, or a name that
 * matches nothing in the tenant's own catalogue (lib/quotes/typed-line-catalog-match.ts).
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { lineCostUnknown } from "@/lib/quotes/line-cost";
import { suggestCatalogMatches } from "@/lib/quotes/typed-line-catalog-match";
import { COMMIT_CHOICES, commitChoiceOf } from "@/lib/quotes/line-commit-choice";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

export function CatalogMatchSuggestion({
  line,
  catalog,
  costFor,
  onUse,
}: {
  line: QuoteLineItem;
  catalog: readonly Item[];
  /** The line's cost from this catalogue row, for the line's commitment (₹, the line's stored unit). */
  costFor: (item: Item, line: QuoteLineItem) => number;
  onUse: (item: Item) => void;
}) {
  const matches = React.useMemo(
    () => (line.item_id || line.bulk || !lineCostUnknown(line) ? [] : suggestCatalogMatches(catalog, line.name)),
    [line, catalog],
  );
  const offers = matches
    .map((item) => ({ item, cost: costFor(item, line) }))
    .filter((o) => o.cost > 0);
  if (offers.length === 0) return null;
  const commitLabel = COMMIT_CHOICES.find((c) => c.value === commitChoiceOf(line.commitment))?.label ?? "";

  return (
    <div className="mt-1 space-y-1" data-testid="catalog-match-suggestion">
      {offers.map(({ item, cost }) => (
        <div key={item.id} className="flex flex-wrap items-center gap-1.5 text-2xs">
          <span className="text-ink-2">Is this <b className="text-ink">{item.name}</b>?</span>
          <button
            type="button"
            onClick={() => onUse(item)}
            className="rounded-md border border-amber/60 bg-amber-soft px-2 py-0.5 font-semibold text-amber-ink hover:bg-amber-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
          >
            Use cost {rupee(cost)}{commitLabel ? ` (${commitLabel})` : ""}
          </button>
        </div>
      ))}
    </div>
  );
}
