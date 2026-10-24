/**
 * R-1815 (24 Oct 2026): the logged-in app at 375px. The dashboard's header buttons (Re-run setup,
 * Quick add lead, New quote) sat in a no-wrap row 444px wide, so the whole page was 460px and
 * scrolled sideways on a phone. And /email (HomeV2) kept its 48px desktop side gutter on a phone,
 * where CLAUDE.md §20 asks for 16px.
 * Source scan — the 375x812 logged-in sweep (scrollWidth vs innerWidth per page) is in the card.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

describe("R-1815 the app fits a 375px phone", () => {
  it("the dashboard header button row wraps", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    const at = src.indexOf("Re-run setup</Link>");
    expect(at).toBeGreaterThan(0);
    const rowOpen = src.lastIndexOf('<div className="', at);
    const row = src.slice(rowOpen, src.indexOf(">", rowOpen));
    expect(row).toMatch(/\bflex-wrap\b/);
  });

  it("/leads: the view/filter row is capped to the column and the sticky bar adds no right slop", () => {
    const bar = read("src/components/features/leads/leads-toolbar.tsx");
    // the Kanban/List/Filter/Sort/More row: shrink-0 kept it at its 356px max-content width
    expect(bar).toMatch(/<div className="flex items-center gap-2 shrink-0 flex-wrap max-w-full">/);
    const page = read("src/app/(app)/leads/page.tsx");
    // -mx-1 pushed the sticky toolbar 4px past the scrolling column's right edge
    expect(page).toMatch(/<div className="sticky top-0 z-10 -ml-1 pl-1 /);
    expect(page).not.toMatch(/<div className="sticky top-0 z-10 -mx-1 /);
  });

  it("/accounting/pnl: From/To dates stack in a two-column grid on a phone", () => {
    const src = read("src/app/(app)/accounting/pnl/page.tsx");
    expect(src).toMatch(/grid w-full grid-cols-\[auto_minmax\(0,1fr\)\] items-center gap-2 sm:flex/);
  });

  it("/payments: the Zoho dues table's scroll box is the containing block for its sr-only header", () => {
    // without `relative`, the absolutely positioned sr-only "Action" escaped the box → page 599px
    const src = read("src/components/features/invoices/opening-invoice-dues-card.tsx");
    expect(src).toMatch(/<div className="relative overflow-x-auto">\s*<table/);
  });

  it("every HomeV2 section gutter shrinks to 16px on a phone", () => {
    const src = read("src/site/components/home/HomeV2.tsx");
    const lines = src.split("\n").filter((l) => /style=\{wrap\(/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((l) => !/\bdata-gutter\b/.test(l))).toEqual([]);
    expect(read("src/site/site.css")).toMatch(
      /@media \(max-width: 639px\) \{\s*\.anutech-site \[data-gutter\] \{ padding-left: 16px !important; padding-right: 16px !important; \}/,
    );
  });
});
