import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

/* ─────────────────────────────────────────────────────────────────────────────
   A CSS Grid trap that renders columns at ZERO WIDTH, reported from /leads on
   22 Aug 2026 as "canban view sahi show nahi ho raha hai".

   The Kanban board carried:

       grid-cols-1 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-[minmax(220px,1fr)]

   Measured in the browser at a 1051px viewport:

       grid-template-columns: 0px 0px 220px 220px 220px 220px

   New (9 leads) and Contacted (26) were the 0px pair — 35 of 37 deals with nowhere to
   render, under a footer reading "37 total deals visible".

   Why: `sm:grid-cols-2` is an EXPLICIT template that nothing reset at `lg`. With
   `grid-auto-flow: column`, items 1-2 fill those explicit tracks and 3-6 create implicit
   ones. `grid-auto-columns` applies ONLY to implicit tracks, so the four implicit columns
   claimed 4x220px of a 779px container and the explicit pair's `1fr` resolved to 0.

   This cannot be caught by a rendering test: jsdom does not do grid layout, so the columns
   measure the same broken and fixed. What CAN be checked is the class combination that
   produces it — the same approach `route-map.test.ts` and the tooltip-shortcut scan take.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      tsxFiles(full, acc);
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every quoted class list in a file, so one attribute is judged as a whole. */
function classLists(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/"([^"\n]*\bgrid-flow-col\b[^"\n]*)"/g)) out.push(m[1]);
  for (const m of source.matchAll(/'([^'\n]*\bgrid-flow-col\b[^'\n]*)'/g)) out.push(m[1]);
  for (const m of source.matchAll(/`([^`\n]*\bgrid-flow-col\b[^`\n]*)`/g)) out.push(m[1]);
  return out;
}

/** A numbered explicit template, at any breakpoint: grid-cols-2, md:grid-cols-3 … */
const NUMBERED_COLS = /(?:^|[\s])(?:[a-z0-9]+:)?grid-cols-\d+/;
/** The reset that makes the auto-columns apply to every track. */
const HAS_RESET = /(?:^|[\s])(?:[a-z0-9]+:)?grid-cols-none/;

describe("grid-flow-col must not sit on top of an unreset numbered grid-cols", () => {
  const files = tsxFiles(SRC);

  it("scanned a real number of .tsx files", () => {
    /* Without this the whole suite passes by scanning nothing — the same vacuous-green
       guard the sandbox isolation and tooltip tests carry. */
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the Kanban board, so the rule is anchored to a real usage", () => {
    /* The board left (app)/leads/page.tsx for its own file in S35 (28 Sep 2026). */
    const board = files.find((f) => f.replace(/\\/g, "/").endsWith("features/leads/leads-kanban-board.tsx"));
    expect(board, "leads-kanban-board.tsx should exist — it owns the board this test exists for").toBeTruthy();
    const lists = classLists(readSource(board!));
    expect(lists.length, "leads-kanban-board.tsx should still use grid-flow-col").toBeGreaterThan(0);
  });

  it("every grid-flow-col class list either has no numbered grid-cols, or resets it", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const list of classLists(readSource(file))) {
        if (!NUMBERED_COLS.test(list)) continue;      // no explicit template — nothing to reset
        if (HAS_RESET.test(list)) continue;           // reset present — the tracks are implicit
        offenders.push(`${file.replace(process.cwd(), "").replace(/\\/g, "/")}\n    ${list.trim()}`);
      }
    }

    expect(
      offenders,
      "grid-flow-col with a numbered grid-cols and no grid-cols-none leaves the explicit "
      + "tracks OUTSIDE grid-auto-columns. They collapse to 0px once the implicit tracks "
      + "claim the container, and the cards in them vanish silently. Add grid-cols-none at "
      + "the breakpoint where grid-flow-col starts.",
    ).toEqual([]);
  });
});
