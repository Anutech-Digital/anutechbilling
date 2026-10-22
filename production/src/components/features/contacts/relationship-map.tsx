"use client";
/**
 * R-1740 — the Contacts "Map": you in the middle, people on rings by closeness
 * (Close inside, Unknown outside), coloured by relationship (pink personal, blue
 * professional, grey unknown). Click a dot = open that person. On a phone the same rings
 * are a grouped list — dots are too small to tap.
 */
import * as React from "react";
import type { UnifiedContact } from "@/lib/queries/contacts";
import { relationshipRing, relationshipTone, relationshipLabel, RING_LABEL } from "@/lib/contacts/relationship";
import { RelationshipChip } from "@/components/features/contacts/relationship-chip";
import { cn } from "@/lib/utils";

const SIZE = 640;
const C = SIZE / 2;
const RADIUS: Record<1 | 2 | 3 | 4, number> = { 1: 80, 2: 150, 3: 220, 4: 290 };
/** Above this many people the dots stop being readable — say so instead of a smear. */
export const MAP_LIMIT = 300;

const DOT_FILL: Record<"pink" | "blue" | "grey", string> = {
  pink: "hsl(var(--rose))",
  blue: "hsl(var(--indigo))",
  grey: "hsl(var(--ink-3))",
};

type Ring = 1 | 2 | 3 | 4;

/** Dots on each ring, spread evenly; a crowded ring is split into 2–3 close lanes. */
export function layoutMap(people: UnifiedContact[]): Array<{ c: UnifiedContact; ring: Ring; x: number; y: number }> {
  const byRing: Record<Ring, UnifiedContact[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const c of people) byRing[relationshipRing(c.relationshipType, c.closeness)].push(c);
  const out: Array<{ c: UnifiedContact; ring: Ring; x: number; y: number }> = [];
  for (const ring of [1, 2, 3, 4] as Ring[]) {
    const list = byRing[ring];
    const r = RADIUS[ring];
    // ~14px between dot centres along the ring before we add a lane.
    const perLane = Math.max(1, Math.floor((2 * Math.PI * r) / 14));
    const lanes = Math.min(3, Math.ceil(list.length / perLane));
    list.forEach((c, i) => {
      const lane = lanes > 1 ? i % lanes : 0;
      const rr = r + (lane - (lanes - 1) / 2) * 12;
      const a = (i / Math.max(1, list.length)) * 2 * Math.PI - Math.PI / 2 + ring * 0.35;
      out.push({ c, ring, x: C + rr * Math.cos(a), y: C + rr * Math.sin(a) });
    });
  }
  return out;
}

export function RelationshipMap({ people, onOpen }: { people: UnifiedContact[]; onOpen: (c: UnifiedContact) => void }) {
  const shown = React.useMemo(() => people.slice(0, MAP_LIMIT), [people]);
  const dots = React.useMemo(() => layoutMap(shown), [shown]);
  const ringCounts = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Ring, number>;
  for (const d of dots) ringCounts[d.ring]++;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {people.length > MAP_LIMIT && (
        <p className="text-xs text-ink-3 mb-2">
          Showing the first {MAP_LIMIT} of {people.length} people — narrow it with the filters above.
        </p>
      )}

      {/* Desktop / tablet — the rings. */}
      <div className="hidden md:flex gap-6 items-start">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="w-full max-w-[560px] h-auto shrink-0"
          role="group"
          aria-label="Relationship map: you in the middle, closer people on inner rings"
        >
          {([4, 3, 2, 1] as Ring[]).map((ring) => (
            <g key={ring}>
              <circle cx={C} cy={C} r={RADIUS[ring]} fill="none" stroke="hsl(var(--hairline-strong))" strokeDasharray={ring === 4 ? "4 4" : undefined} />
              <text x={C} y={C - RADIUS[ring] - 6} textAnchor="middle" fontSize="11" fill="hsl(var(--ink-3))">
                {RING_LABEL[ring]} · {ringCounts[ring]}
              </text>
            </g>
          ))}
          <circle cx={C} cy={C} r={26} fill="hsl(var(--amber-soft))" stroke="hsl(var(--amber))" />
          <text x={C} y={C + 4} textAnchor="middle" fontSize="12" fontWeight="600" fill="hsl(var(--amber-ink))">You</text>
          {dots.map(({ c, x, y }) => {
            const name = c.name ?? c.email ?? "Contact";
            const label = `${name} — ${relationshipLabel(c.relationshipType, c.closeness)}. Open`;
            return (
              <g
                key={c.id}
                role="button"
                tabIndex={0}
                aria-label={label}
                onClick={() => onOpen(c)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c); } }}
                className="cursor-pointer focus:outline-none [&:focus-visible>circle]:stroke-[hsl(var(--amber))] [&:focus-visible>circle]:stroke-[3px]"
              >
                <title>{`${name} · ${relationshipLabel(c.relationshipType, c.closeness)}`}</title>
                <circle cx={x} cy={y} r={6} fill={DOT_FILL[relationshipTone(c.relationshipType)]} stroke="hsl(var(--paper))" strokeWidth={1.5} />
              </g>
            );
          })}
        </svg>
        <div className="space-y-2 text-xs text-ink-2 pt-2">
          <p className="font-semibold text-ink">Colour</p>
          <Legend tone="pink" text="Personal — friend, relative, acquaintance" />
          <Legend tone="blue" text="Professional — client, partner, vendor, colleague" />
          <Legend tone="grey" text="Unknown — relationship not set" />
          <p className="pt-2 text-ink-3 max-w-[16rem]">
            Inner ring = closest. Click a dot to open the person; set the relationship on their page.
          </p>
        </div>
      </div>

      {/* Phone — the same rings as a list. */}
      <div className="md:hidden space-y-4">
        {([1, 2, 3, 4] as Ring[]).map((ring) => {
          const list = dots.filter((d) => d.ring === ring);
          if (list.length === 0) return null;
          return (
            <section key={ring}>
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-1.5">
                {RING_LABEL[ring]} · {list.length}
              </h3>
              <ul className="space-y-1.5">
                {list.map(({ c }) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(c)}
                      className="w-full flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-left"
                    >
                      <span className="min-w-0 truncate text-sm text-ink">{c.name ?? c.email ?? "Contact"}</span>
                      <RelationshipChip type={c.relationshipType} closeness={c.closeness} size="sm" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ tone, text }: { tone: "pink" | "blue" | "grey"; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={cn("inline-block w-2.5 h-2.5 rounded-full")} style={{ background: DOT_FILL[tone] }} />
      <span>{text}</span>
    </div>
  );
}
