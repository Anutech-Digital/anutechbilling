/**
 * R-197 — on /deals (and /leads) the Kanban board and the List must stay reachable when
 * the screen is short.
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * The page wrapper fixes its height to the viewport and hides overflow (the board needs a
 * bounded box). The main column under it was `flex flex-col min-h-0` with NO scroll of its
 * own. On a 938px-tall window the hot-lead card plus "Today's priority call queue" took
 * most of the column, so the board (Quote Sent / Won columns at ~1250px) and the list rows
 * were clipped: content 1638px (kanban) / 1186px (list) inside an 882px box, and the mouse
 * wheel only moved the call queue's own scroll. Measured in the running app, 6 Oct 2026.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * 1. The main column scrolls (`overflow-y-auto`), so whatever sits above the board can be
 *    scrolled past.
 * 2. Inside a scrolling flex column a `flex-1 min-h-0` child shrinks to nothing, so the
 *    board and the list each need a height floor (`min-h-[…px]`) — otherwise the fix
 *    "works" by squashing the board to 0px.
 *
 * jsdom has no layout engine, so — like card-list-scroll.test.ts — this checks classes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, "page.tsx"), "utf8");
const board = readFileSync(
  join(HERE, "..", "..", "..", "components", "features", "leads", "leads-kanban-board.tsx"),
  "utf8",
);

describe("R-197: board and list are reachable on a short screen", () => {
  it("the page still clips its own height (else this rule is obsolete)", () => {
    expect(page).toMatch(/h-\[calc\(100vh-3\.5rem\)\][^"]*overflow-hidden/);
  });

  it("the main column scrolls, so the call queue can be scrolled past", () => {
    const mainCol = page.match(/<div className="(flex-1 min-w-0 flex flex-col min-h-0[^"]*)"/);
    expect(mainCol, "main column div not found").not.toBeNull();
    expect(mainCol?.[1]).toMatch(/overflow-y-auto/);
  });

  it("the Kanban board keeps a height floor inside the scroll", () => {
    expect(board).toMatch(/className="flex-1 min-h-\[\d+px\][^"]*"/);
  });

  it("the List keeps a height floor inside the scroll", () => {
    expect(page).toMatch(/<div className="[^"]*min-h-\[\d+px\][^"]*">\s*<LeadListView/);
  });
});
