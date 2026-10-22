"use client";
/**
 * R-1740 — the two filter rows on /contacts (Business, Relationship) and the small
 * Relationship × Business grid. Counts are PEOPLE only and faceted: each row's counts
 * follow the other row's choice (see facetCounts in lib/contacts/relationship.ts).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import {
  BIZ_FACETS, BIZ_LABEL, REL_FACETS, REL_LABEL,
  type BizFacet, type FacetCounts, type RelFacet,
} from "@/lib/contacts/relationship";

function Pill({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs font-medium transition-colors whitespace-nowrap",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
        on ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:bg-paper-2",
      )}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums text-ink-3">{n}</span>;
}

export function ContactsFacetRows({
  counts, biz, rel, onBiz, onRel,
}: {
  counts: FacetCounts;
  biz: BizFacet | "all";
  rel: RelFacet | "all";
  onBiz: (v: BizFacet | "all") => void;
  onRel: (v: RelFacet | "all") => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-24 shrink-0 text-2xs font-semibold uppercase tracking-wider text-ink-3">Business</span>
        <Pill on={biz === "all"} onClick={() => onBiz("all")} label={`Business: All, ${counts.biz.all} people`}>
          All <Count n={counts.biz.all} />
        </Pill>
        {BIZ_FACETS.map((b) => (
          <Pill key={b} on={biz === b} onClick={() => onBiz(b)} label={`Business: ${BIZ_LABEL[b]}, ${counts.biz[b]} people`}>
            {BIZ_LABEL[b]} <Count n={counts.biz[b]} />
          </Pill>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-24 shrink-0 text-2xs font-semibold uppercase tracking-wider text-ink-3">Relationship</span>
        <Pill on={rel === "all"} onClick={() => onRel("all")} label={`Relationship: All, ${counts.rel.all} people`}>
          All <Count n={counts.rel.all} />
        </Pill>
        {REL_FACETS.map((r) => (
          <Pill key={r} on={rel === r} onClick={() => onRel(r)} label={`Relationship: ${REL_LABEL[r]}, ${counts.rel[r]} people`}>
            {REL_LABEL[r]} <Count n={counts.rel[r]} />
          </Pill>
        ))}
      </div>
    </div>
  );
}

/** Relationship (rows) × Business (columns). A cell = exactly those people. */
export function RelationshipBusinessGrid({
  grid, biz, rel, onPick,
}: {
  grid: FacetCounts["grid"];
  biz: BizFacet | "all";
  rel: RelFacet | "all";
  onPick: (biz: BizFacet, rel: RelFacet) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <caption className="sr-only">People by relationship and business</caption>
        <thead>
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-semibold text-ink-3"><span className="sr-only">Relationship</span></th>
            {BIZ_FACETS.map((b) => (
              <th key={b} scope="col" className="px-2 py-1 text-right font-semibold text-ink-3 whitespace-nowrap">{BIZ_LABEL[b]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {REL_FACETS.map((r) => (
            <tr key={r} className="border-t border-hairline">
              <th scope="row" className="px-2 py-1 text-left font-medium text-ink-2 whitespace-nowrap">{REL_LABEL[r]}</th>
              {BIZ_FACETS.map((b) => {
                const n = grid[r][b];
                const on = biz === b && rel === r;
                return (
                  <td key={b} className="px-1 py-0.5 text-right">
                    <button
                      type="button"
                      disabled={n === 0}
                      aria-pressed={on}
                      aria-label={`${REL_LABEL[r]} × ${BIZ_LABEL[b]}: ${n} people`}
                      onClick={() => onPick(b, r)}
                      className={cn(
                        "min-w-[2.25rem] h-6 rounded px-1.5 tabular-nums transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                        on ? "bg-amber text-white font-semibold"
                          : n === 0 ? "text-ink-4 cursor-default"
                          : "text-ink hover:bg-amber-soft",
                      )}
                    >
                      {n}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
